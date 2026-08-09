import { constants as fsConstants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleRecord = {
  id: string;
  prompt: string;
  dueAt: string;
  recurrence: Recurrence | null;
  enabled: boolean;
  lastRunAt: string | null;
  runCount: number;
};
type StoredScheduleRecord = ScheduleRecord & Record<string, unknown>;

type ScheduleFile = {
  version: 1;
  schedules: StoredScheduleRecord[];
} & Record<string, unknown>;

type ScheduleSnapshot = {
  file: ScheduleFile;
  raw: string;
};

type MaybePromise<T> = T | PromiseLike<T>;
export type WorkspaceSchedulerOptions = {
  dataDir: string;
  run: (chatId: number, prompt: string) => MaybePromise<string | undefined>;
  send: (chatId: number, text: string) => MaybePromise<void>;
  pollIntervalMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: (error: unknown) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_TIMER_MS = 2_147_483_647;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const CHAT_DIRECTORY = /^-?(?:0|[1-9]\d*)$/u;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const READ_ONLY = fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW;
const READ_FILE = fsConstants.O_RDONLY | NO_FOLLOW;
const WRITE_NEW = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW;
const UTC_ISO = /Z$/u;

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

type PinnedDirectory = {
  handle: Awaited<ReturnType<typeof open>>;
  path: string;
  realPath: string;
};

async function openPinnedDirectory(directory: string, expectedRealPath?: string): Promise<PinnedDirectory> {
  const initial = await lstat(directory);
  if (!isDirectory(initial)) throw new Error(`Scheduler path is not a real directory: ${directory}`);
  const canonical = await realpath(directory);
  if (expectedRealPath !== undefined && canonical !== expectedRealPath) {
    throw new Error(`Scheduler directory is not stable: ${directory}`);
  }
  const canonicalStat = await lstat(canonical);
  if (!isDirectory(canonicalStat)) throw new Error(`Scheduler path is not a real directory: ${directory}`);
  const handle = await open(canonical, READ_ONLY);
  try {
    const openedStat = await handle.stat();
    if (!isDirectory(openedStat) || openedStat.dev !== canonicalStat.dev || openedStat.ino !== canonicalStat.ino) {
      throw new Error(`Scheduler directory changed while opening: ${directory}`);
    }
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (openedPath !== canonical) throw new Error(`Scheduler directory is not stable: ${directory}`);
    return { handle, path: `/proc/self/fd/${handle.fd}`, realPath: canonical };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function closeDirectory(directory: PinnedDirectory): Promise<void> {
  await directory.handle.close().catch(() => {});
}

function isDirectory(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function numericChatId(name: string): number | undefined {
  if (!CHAT_DIRECTORY.test(name)) return undefined;
  const chatId = Number(name);
  if (!Number.isSafeInteger(chatId) || String(chatId) !== name) return undefined;
  return chatId;
}

function isUtcIso(value: unknown): value is string {
  return typeof value === "string" && UTC_ISO.test(value) && Number.isFinite(Date.parse(value));
}

function invalid(message: string): never {
  throw new Error(`Invalid schedules file: ${message}`);
}

function validateRecord(value: unknown, index: number): StoredScheduleRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`record ${index} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) invalid(`record ${index} has an invalid id`);
  if (typeof record.prompt !== "string" || record.prompt.length === 0) invalid(`record ${index} has an invalid prompt`);
  if (!isUtcIso(record.dueAt)) invalid(`record ${index} has an invalid dueAt`);
  if (record.recurrence !== null && record.recurrence !== "hourly" && record.recurrence !== "daily" && record.recurrence !== "weekly") {
    invalid(`record ${index} has an invalid recurrence`);
  }
  if (typeof record.enabled !== "boolean") invalid(`record ${index} has an invalid enabled flag`);
  if (record.lastRunAt !== null && !isUtcIso(record.lastRunAt)) invalid(`record ${index} has an invalid lastRunAt`);
  if (typeof record.runCount !== "number" || !Number.isSafeInteger(record.runCount) || record.runCount < 0 || record.runCount > Number.MAX_SAFE_INTEGER) {
    invalid(`record ${index} has an invalid runCount`);
  }
  return { ...record } as StoredScheduleRecord;
}

function validateScheduleFile(value: unknown): ScheduleFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("root must be an object");
  const file = value as Record<string, unknown>;
  if (file.version !== 1) invalid("version must be 1");
  if (!Array.isArray(file.schedules)) invalid("schedules must be an array");
  const ids = new Set<string>();
  const schedules = file.schedules.map((record, index) => {
    const validated = validateRecord(record, index);
    if (ids.has(validated.id)) invalid(`duplicate id ${validated.id}`);
    ids.add(validated.id);
    return validated;
  });
  return { ...file, version: 1, schedules } as ScheduleFile;
}

function recurrencePeriod(recurrence: Recurrence): number {
  if (recurrence === "hourly") return HOUR_MS;
  if (recurrence === "daily") return DAY_MS;
  return WEEK_MS;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function advanceRecurring(dueAt: string, recurrence: Recurrence, now: number): string {
  const due = Date.parse(dueAt);
  if (due > now) return dueAt;
  const period = recurrencePeriod(recurrence);
  const periods = Math.floor((now - due) / period) + 1;
  return new Date(due + periods * period).toISOString();
}

async function closeQuietly(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Preserve the original read/write error.
  }
}

/** Poll workspace-owned schedules from agent-written UTC ISO timestamps. */
export class WorkspaceScheduler {
  private readonly dataDir: string;
  private readonly run: WorkspaceSchedulerOptions["run"];
  private readonly send: WorkspaceSchedulerOptions["send"];
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceSchedulerOptions) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_TIMER_MS) {
      throw new Error("Scheduler poll interval must be a positive timer-safe integer");
    }
    this.dataDir = path.resolve(options.dataDir);
    this.run = options.run;
    this.send = options.send;
    this.pollIntervalMs = pollIntervalMs;
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Workspace scheduler error", error));
  }

  async start(): Promise<void> {
    if (this.running) {
      if (this.startInFlight) await this.startInFlight;
      return;
    }
    this.running = true;
    const initialPoll = this.poll();
    this.startInFlight = initialPoll;
    try {
      await initialPoll;
    } finally {
      if (this.startInFlight === initialPoll) this.startInFlight = undefined;
    }
    if (!this.running || this.timer !== undefined) return;
    this.timer = this.schedule(() => {
      void this.poll().catch((error) => this.report(error));
    }, this.pollIntervalMs);
    const unref = (this.timer as unknown as { unref?: () => void }).unref;
    unref?.call(this.timer);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    const pendingStart = this.startInFlight;
    if (pendingStart) await pendingStart.catch(() => {});
    const pendingPoll = this.pollInFlight;
    if (pendingPoll) await pendingPoll.catch(() => {});
  }

  /** Poll numeric chat workspaces; concurrent calls share one operation. */
  async poll(now = this.now()): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    const operation = this.runPoll(now);
    this.pollInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.pollInFlight === operation) this.pollInFlight = undefined;
    }
  }

  private async runPoll(now: number): Promise<void> {
    let chatsRoot: PinnedDirectory | undefined;
    const openDirectories: PinnedDirectory[] = [];
    try {
      chatsRoot = await openPinnedDirectory(path.join(this.dataDir, "chats"));
      openDirectories.push(chatsRoot);
      const entries = await readdir(chatsRoot.path, { withFileTypes: true });
      const chats = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => ({ name: entry.name, chatId: numericChatId(entry.name) }))
        .filter((entry): entry is { name: string; chatId: number } => entry.chatId !== undefined)
        .sort((a, b) => a.chatId - b.chatId || a.name.localeCompare(b.name));

      const due: Array<{ chatId: number; metadata: PinnedDirectory; record: StoredScheduleRecord }> = [];
      for (const { name, chatId } of chats) {
        let chatDirectory: PinnedDirectory | undefined;
        let workspace: PinnedDirectory | undefined;
        let metadata: PinnedDirectory | undefined;
        try {
          const expectedChat = path.join(chatsRoot.realPath, name);
          chatDirectory = await openPinnedDirectory(path.join(chatsRoot.path, name), expectedChat);
          workspace = await openPinnedDirectory(path.join(chatDirectory.path, "workspace"), path.join(chatDirectory.realPath, "workspace"));
          metadata = await openPinnedDirectory(path.join(workspace.path, ".tg-bot"), path.join(workspace.realPath, ".tg-bot"));
          openDirectories.push(chatDirectory, workspace, metadata);
          const scheduleSnapshot = await this.readSchedule(metadata, chatId);
          if (!scheduleSnapshot) continue;
          for (const record of scheduleSnapshot.file.schedules) {
            if (record.enabled && Date.parse(record.dueAt) <= now) due.push({ chatId, metadata, record });
          }
        } catch (error) {
          if (!isMissing(error)) this.report(new Error(`Could not read schedules for chat ${chatId}`, { cause: error }));
          if (metadata && !openDirectories.includes(metadata)) await closeDirectory(metadata);
          if (workspace && !openDirectories.includes(workspace)) await closeDirectory(workspace);
          if (chatDirectory && !openDirectories.includes(chatDirectory)) await closeDirectory(chatDirectory);
        }
      }

      due.sort((a, b) => Date.parse(a.record.dueAt) - Date.parse(b.record.dueAt) || a.chatId - b.chatId || compareStrings(a.record.id, b.record.id));
      for (const item of due) await this.processRecord(item, now);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    } finally {
      for (const directory of openDirectories.reverse()) await closeDirectory(directory);
    }
  }

  private async processRecord(item: { chatId: number; metadata: PinnedDirectory; record: StoredScheduleRecord }, now: number): Promise<void> {
    const currentSnapshot = await this.readSchedule(item.metadata, item.chatId);
    const current = currentSnapshot?.file.schedules.find((record) => record.id === item.record.id);
    if (!current || !current.enabled || Date.parse(current.dueAt) > now) return;

    let output: string | undefined;
    try {
      output = await this.run(item.chatId, current.prompt);
      if (typeof output === "string" && output.trim().length > 0) await this.send(item.chatId, output);
    } catch (error) {
      this.report(new Error(`Schedule ${current.id} for chat ${item.chatId} was not completed`, { cause: error }));
      return;
    }

    try {
      await this.markRun(item.metadata, item.chatId, current.id, now);
    } catch (error) {
      this.report(new Error(`Could not update schedule ${current.id} for chat ${item.chatId}`, { cause: error }));
    }
  }

  private async readSchedule(metadata: PinnedDirectory, chatId: number): Promise<ScheduleSnapshot | undefined> {
    const filePath = path.join(metadata.path, "schedules.json");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let raw: string;
    try {
      handle = await open(filePath, READ_FILE);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("schedules.json is not a regular file");
      raw = await handle.readFile("utf8");
    } catch (error) {
      if (!isMissing(error)) this.report(new Error(`Could not read schedules for chat ${chatId}`, { cause: error }));
      return undefined;
    } finally {
      if (handle) await closeQuietly(handle);
    }

    try {
      return { file: validateScheduleFile(JSON.parse(raw) as unknown), raw };
    } catch (error) {
      this.report(new Error(`Malformed schedules for chat ${chatId}`, { cause: error }));
      return undefined;
    }
  }

  private async markRun(metadata: PinnedDirectory, chatId: number, id: string, now: number): Promise<void> {
    const snapshot = await this.readSchedule(metadata, chatId);
    if (!snapshot) return;
    const { file } = snapshot;
    const index = file.schedules.findIndex((record) => record.id === id);
    if (index < 0) return;
    const current = file.schedules[index];
    if (!current) return;
    const updated: StoredScheduleRecord = {
      ...current,
      lastRunAt: new Date(now).toISOString(),
      runCount: Math.min(current.runCount + 1, Number.MAX_SAFE_INTEGER),
    };
    if (current.recurrence === null) {
      updated.enabled = false;
    } else if (current.enabled) {
      updated.dueAt = advanceRecurring(current.dueAt, current.recurrence, now);
    }
    file.schedules[index] = updated;
    await this.writeSchedule(metadata, file, snapshot.raw);
  }

  private async writeSchedule(metadata: PinnedDirectory, file: ScheduleFile, expectedRaw: string): Promise<void> {
    const filePath = path.join(metadata.path, "schedules.json");
    const temporaryPath = path.join(metadata.path, `schedules.json.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, WRITE_NEW, 0o600);
      await handle.writeFile(`${JSON.stringify(file)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      let latest: Awaited<ReturnType<typeof open>> | undefined;
      try {
        latest = await open(filePath, READ_FILE);
        const latestStat = await latest.stat();
        if (!latestStat.isFile() || latestStat.isSymbolicLink()) throw new Error("schedules.json is not a regular file");
        const latestRaw = await latest.readFile("utf8");
        if (latestRaw !== expectedRaw) throw new Error("schedules.json changed while updating; leaving schedule due for a later poll");
        await rename(temporaryPath, filePath);
      } finally {
        if (latest) await closeQuietly(latest);
      }
    } finally {
      if (handle) await closeQuietly(handle);
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Logging must not stop another chat's schedule from being processed.
    }
  }
}
