import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { conversationAgent, type ConversationAgentRef } from "./agent-ref.js";
import type { WorkspaceTimeline } from "./events.js";
import type { Recurrence, ScheduleRow } from "./schedule-protocol.js";
import { isMissing, openPinnedDirectory, readFileBounded, type PinnedDirectory } from "./util.js";

type ScheduleFile = {
  version: 1;
  schedules: ScheduleRow[];
};

type ScheduleStateFile = {
  version: 1;
  rows: Array<{ key: string; nextDueAt: string | null }>;
};

export type WorkspaceSchedulerOptions = {
  workspace: string;
  statePath: string;
  timeline: WorkspaceTimeline;
  fireTask?: (occurrenceId: string, prompt: string, origin: ConversationAgentRef) => Promise<void>;
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
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const READ_FILE = fsConstants.O_RDONLY | NO_FOLLOW | fsConstants.O_NONBLOCK;
const SCHEDULES_FILE = ".schedules.json";
const MAX_SCHEDULE_PROMPT_LENGTH = 16 * 1024;
const MAX_SCHEDULES_FILE_BYTES = 1024 * 1024;
const MAX_STATE_FILE_BYTES = 1024 * 1024;
const UTC_ISO = /Z$/u;

function isUtcIso(value: unknown): value is string {
  return typeof value === "string" && UTC_ISO.test(value) && Number.isFinite(Date.parse(value));
}

function invalid(message: string): never {
  throw new Error(`Invalid schedules file: ${message}`);
}

function validateOrigin(value: unknown, index: number): ScheduleRow["origin"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`row ${index} has an invalid origin`);
  const origin = value as Record<string, unknown>;
  if (typeof origin.chat_id !== "number" || !Number.isSafeInteger(origin.chat_id)) invalid(`row ${index} has an invalid origin.chat_id`);
  if (origin.message_thread_id !== undefined && (typeof origin.message_thread_id !== "number" || !Number.isSafeInteger(origin.message_thread_id))) {
    invalid(`row ${index} has an invalid origin.message_thread_id`);
  }
  return { chat_id: origin.chat_id, ...(typeof origin.message_thread_id === "number" ? { message_thread_id: origin.message_thread_id } : {}) };
}

function validateRow(value: unknown, index: number): ScheduleRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`row ${index} must be an object`);
  const row = value as Record<string, unknown>;
  if (typeof row.prompt !== "string" || row.prompt.length === 0 || row.prompt.length > MAX_SCHEDULE_PROMPT_LENGTH) {
    invalid(`row ${index} has an invalid prompt`);
  }
  if (!isUtcIso(row.start)) invalid(`row ${index} has an invalid start`);
  if (row.recurrence !== null && row.recurrence !== "hourly" && row.recurrence !== "daily" && row.recurrence !== "weekly") {
    invalid(`row ${index} has an invalid recurrence`);
  }
  return { prompt: row.prompt, start: row.start, recurrence: row.recurrence as Recurrence | null, origin: validateOrigin(row.origin, index) };
}

function validateScheduleFile(value: unknown): ScheduleFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("root must be an object");
  const file = value as Record<string, unknown>;
  if (file.version !== 1) invalid("version must be 1");
  if (!Array.isArray(file.schedules)) invalid("schedules must be an array");
  return { version: 1, schedules: file.schedules.map(validateRow) };
}

function validateStateFile(value: unknown): ScheduleStateFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scheduler state");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.rows)) throw new Error("Invalid scheduler state");
  const rows = file.rows.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scheduler state row");
    const row = value as Record<string, unknown>;
    if (typeof row.key !== "string" || (row.nextDueAt !== null && !isUtcIso(row.nextDueAt))) {
      throw new Error("Invalid scheduler state row");
    }
    return { key: row.key, nextDueAt: row.nextDueAt as string | null };
  });
  return { version: 1, rows };
}

function rowKey(row: ScheduleRow): string {
  return JSON.stringify([row.prompt, row.start, row.recurrence, row.origin.chat_id, row.origin.message_thread_id ?? 0]);
}

function advanceRecurring(dueAt: string, recurrence: Recurrence, now: number): string {
  const due = Date.parse(dueAt);
  if (due > now) return dueAt;
  const period = recurrence === "hourly" ? HOUR_MS : recurrence === "daily" ? DAY_MS : WEEK_MS;
  const periods = Math.floor((now - due) / period) + 1;
  return new Date(due + periods * period).toISOString();
}

async function closeQuietly(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Preserve the original read error.
  }
}

async function readSchedulesFile(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw new Error(".schedules.json is not a regular file");
  if (stat.size > MAX_SCHEDULES_FILE_BYTES) throw new Error(`.schedules.json exceeds ${MAX_SCHEDULES_FILE_BYTES} bytes`);
  return (await readFileBounded(handle, MAX_SCHEDULES_FILE_BYTES)).toString("utf8");
}

export class WorkspaceScheduler {
  private readonly workspace: string;
  private readonly statePath: string;
  private readonly timeline: WorkspaceTimeline;
  private readonly fireTask: WorkspaceSchedulerOptions["fireTask"];
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private readonly state = new Map<string, string | null>();
  private stateLoaded = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceSchedulerOptions) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_TIMER_MS) {
      throw new Error("Scheduler poll interval must be a positive timer-safe integer");
    }
    this.workspace = path.resolve(options.workspace);
    this.statePath = path.resolve(options.statePath);
    this.timeline = options.timeline;
    this.fireTask = options.fireTask;
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
    if (!this.running) return;
    this.timer = this.schedule(() => void this.poll().catch((error) => this.report(error)), this.pollIntervalMs);
    this.timer.unref?.();
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
    let workspace: PinnedDirectory | undefined;
    try {
      if (!this.stateLoaded) await this.loadState();
      workspace = await openPinnedDirectory(this.workspace);
      const rows = await this.readRows(workspace);
      if (rows) await this.reconcile(rows, now);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    } finally {
      if (workspace) await closeQuietly(workspace.handle);
    }
  }

  private async reconcile(rows: ScheduleRow[], now: number): Promise<void> {
    const previous = new Map(this.state);
    const byKey = new Map(rows.map((row) => [rowKey(row), row]));
    let changed = false;
    for (const key of this.state.keys()) {
      if (!byKey.has(key)) {
        this.state.delete(key);
        changed = true;
      }
    }
    for (const [key, row] of byKey) {
      if (!this.state.has(key)) {
        this.state.set(key, row.start);
        changed = true;
      }
    }

    const due: Array<{ occurrenceId: string; row: ScheduleRow; dueAt: string }> = [];
    for (const [key, row] of byKey) {
      const dueAt = this.state.get(key);
      if (dueAt === undefined || dueAt === null || Date.parse(dueAt) > now) continue;
      due.push({ occurrenceId: randomUUID(), row, dueAt });
      this.state.set(key, row.recurrence === null ? null : advanceRecurring(dueAt, row.recurrence, now));
      changed = true;
    }
    if (changed) {
      try {
        await this.saveState();
      } catch (error) {
        this.state.clear();
        for (const [key, dueAt] of previous) this.state.set(key, dueAt);
        throw error;
      }
    }

    due.sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt) || left.row.prompt.localeCompare(right.row.prompt));
    for (const occurrence of due) {
      const origin = conversationAgent(occurrence.row.origin.chat_id, occurrence.row.origin.message_thread_id ?? 0);
      await this.timeline.publish({
        type: "schedule_fired",
        occurrenceId: occurrence.occurrenceId,
        prompt: occurrence.row.prompt,
        dueAt: occurrence.dueAt,
        origin,
      });
      if (this.fireTask) await this.fireTask(occurrence.occurrenceId, occurrence.row.prompt, origin).catch((error) => this.report(error));
    }
  }

  private async loadState(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.statePath, READ_FILE);
    } catch (error) {
      if (isMissing(error)) {
        this.stateLoaded = true;
        return;
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STATE_FILE_BYTES) throw new Error("Invalid scheduler state file");
      const raw = (await readFileBounded(handle, MAX_STATE_FILE_BYTES)).toString("utf8");
      const parsed = validateStateFile(JSON.parse(raw) as unknown);
      this.state.clear();
      for (const row of parsed.rows) this.state.set(row.key, row.nextDueAt);
      this.stateLoaded = true;
    } finally {
      await closeQuietly(handle);
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    const file: ScheduleStateFile = {
      version: 1,
      rows: [...this.state].map(([key, nextDueAt]) => ({ key, nextDueAt })),
    };
    try {
      await writeFile(temporary, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.statePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async readRows(metadata: PinnedDirectory): Promise<ScheduleRow[] | undefined> {
    const filePath = path.join(metadata.path, SCHEDULES_FILE);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let raw: string;
    try {
      handle = await open(filePath, READ_FILE);
      raw = await readSchedulesFile(handle);
    } catch (error) {
      if (!isMissing(error)) this.report(new Error("Could not read schedules", { cause: error }));
      return undefined;
    } finally {
      if (handle) await closeQuietly(handle);
    }
    try {
      return validateScheduleFile(JSON.parse(raw) as unknown).schedules;
    } catch (error) {
      this.report(new Error("Malformed schedules", { cause: error }));
      return undefined;
    }
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt schedule processing.
    }
  }
}
