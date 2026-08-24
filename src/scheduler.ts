import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { conversationAgent, sameConversation, type ConversationAgentRef } from "./agent-ref.js";
import type { WorkspaceTimeline } from "./events.js";
import { SerialQueue } from "./queue.js";
import type { Recurrence, Schedule, ScheduleInput, ScheduleOwner } from "./schedule-protocol.js";
import { isMissing, readFileBounded } from "./util.js";

type ScheduleFile = {
  version: 1;
  schedules: Schedule[];
};

type LegacyScheduleRow = ScheduleInput & { owner: ScheduleOwner };
type LegacyScheduleFile = { version: 1; schedules: LegacyScheduleRow[] };
type LegacyStateFile = { version: 1; rows: Array<{ key: string; nextDueAt: string | null }> };

export type WorkspaceSchedulerOptions = {
  workspace: string;
  schedulePath: string;
  legacyStatePath?: string;
  timeline: WorkspaceTimeline;
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
const READ_FILE = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const LEGACY_SCHEDULES_FILE = ".schedules.json";
const MAX_SCHEDULE_PROMPT_LENGTH = 16 * 1024;
const MAX_SCHEDULE_FILE_BYTES = 1024 * 1024;
const UTC_ISO = /Z$/u;

function isUtcIso(value: unknown): value is string {
  return typeof value === "string" && UTC_ISO.test(value) && Number.isFinite(Date.parse(value));
}

function invalid(message: string): never {
  throw new Error(`Invalid schedule: ${message}`);
}

function validateOwner(value: unknown, context: string): ScheduleOwner {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${context} has an invalid owner`);
  const owner = value as Record<string, unknown>;
  if (typeof owner.chat_id !== "number" || !Number.isSafeInteger(owner.chat_id)) invalid(`${context} has an invalid owner.chat_id`);
  if (owner.message_thread_id !== undefined && (typeof owner.message_thread_id !== "number" || !Number.isSafeInteger(owner.message_thread_id))) {
    invalid(`${context} has an invalid owner.message_thread_id`);
  }
  return { chat_id: owner.chat_id, ...(typeof owner.message_thread_id === "number" ? { message_thread_id: owner.message_thread_id } : {}) };
}

function validateInput(value: unknown, context: string): ScheduleInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${context} must be an object`);
  const input = value as Record<string, unknown>;
  if (typeof input.prompt !== "string" || input.prompt.length === 0 || input.prompt.length > MAX_SCHEDULE_PROMPT_LENGTH) {
    invalid(`${context} has an invalid prompt`);
  }
  if (!isUtcIso(input.start)) invalid(`${context} has an invalid start`);
  if (input.recurrence !== null && input.recurrence !== "hourly" && input.recurrence !== "daily" && input.recurrence !== "weekly") {
    invalid(`${context} has an invalid recurrence`);
  }
  return { prompt: input.prompt, start: input.start, recurrence: input.recurrence as Recurrence | null };
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalid("id must be a non-empty string");
  return value;
}

function validateScheduleFile(value: unknown): ScheduleFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid schedules state");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.schedules)) throw new Error("Invalid schedules state");
  const ids = new Set<string>();
  const schedules = file.schedules.map((value, index) => {
    const context = `row ${index}`;
    const input = validateInput(value, context);
    const row = value as Record<string, unknown>;
    const id = validateId(row.id);
    if (ids.has(id)) throw new Error(`Invalid schedules state: duplicate id ${id}`);
    ids.add(id);
    if (row.next_due_at !== null && !isUtcIso(row.next_due_at)) throw new Error(`Invalid schedules state: ${context} has an invalid next_due_at`);
    return { id, ...input, owner: validateOwner(row.owner, context), next_due_at: row.next_due_at as string | null };
  });
  return { version: 1, schedules };
}

function validateLegacyScheduleFile(value: unknown): LegacyScheduleFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy schedules file");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.schedules)) throw new Error("Invalid legacy schedules file");
  return {
    version: 1,
    schedules: file.schedules.map((value, index) => ({
      ...validateInput(value, `legacy row ${index}`),
      owner: validateOwner((value as Record<string, unknown>).owner, `legacy row ${index}`),
    })),
  };
}

function validateLegacyStateFile(value: unknown): LegacyStateFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy scheduler state");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.rows)) throw new Error("Invalid legacy scheduler state");
  return {
    version: 1,
    rows: file.rows.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy scheduler state row");
      const row = value as Record<string, unknown>;
      if (typeof row.key !== "string" || (row.nextDueAt !== null && !isUtcIso(row.nextDueAt))) throw new Error("Invalid legacy scheduler state row");
      return { key: row.key, nextDueAt: row.nextDueAt as string | null };
    }),
  };
}

function legacyRowKey(row: LegacyScheduleRow): string {
  return JSON.stringify([row.prompt, row.start, row.recurrence, row.owner.chat_id, row.owner.message_thread_id ?? 0]);
}

function oldLegacyRowKey(row: LegacyScheduleRow): string {
  return JSON.stringify([row.prompt, row.start, row.recurrence]);
}

function advanceRecurring(dueAt: string, recurrence: Recurrence, now: number): string {
  const due = Date.parse(dueAt);
  if (due > now) return dueAt;
  const period = recurrence === "hourly" ? HOUR_MS : recurrence === "daily" ? DAY_MS : WEEK_MS;
  const periods = Math.floor((now - due) / period) + 1;
  return new Date(due + periods * period).toISOString();
}

function scheduleOwner(owner: ConversationAgentRef): ScheduleOwner {
  return { chat_id: owner.chatId, ...(owner.threadId === 0 ? {} : { message_thread_id: owner.threadId }) };
}

function ownerRef(owner: ScheduleOwner): ConversationAgentRef {
  return conversationAgent(owner.chat_id, owner.message_thread_id ?? 0);
}

function cloneSchedule(schedule: Schedule): Schedule {
  return { ...schedule, owner: { ...schedule.owner } };
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, READ_FILE);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SCHEDULE_FILE_BYTES) throw new Error(`Invalid schedule file: ${filePath}`);
    return (await readFileBounded(handle, MAX_SCHEDULE_FILE_BYTES)).toString("utf8");
  } finally {
    await handle.close();
  }
}

export class WorkspaceScheduler {
  private readonly legacySchedulesPath: string;
  private readonly schedulePath: string;
  private readonly legacyStatePath: string | undefined;
  private readonly timeline: WorkspaceTimeline;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly scheduleTimer: typeof setInterval;
  private readonly cancelTimer: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private readonly schedules = new Map<string, Schedule>();
  private readonly writes = new SerialQueue();
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
    this.legacySchedulesPath = path.join(path.resolve(options.workspace), LEGACY_SCHEDULES_FILE);
    this.schedulePath = path.resolve(options.schedulePath);
    this.legacyStatePath = options.legacyStatePath === undefined ? undefined : path.resolve(options.legacyStatePath);
    this.timeline = options.timeline;
    this.pollIntervalMs = pollIntervalMs;
    this.now = options.now ?? Date.now;
    this.scheduleTimer = options.setInterval ?? setInterval;
    this.cancelTimer = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Workspace scheduler error", error));
  }

  async add(params: Record<string, unknown>, owner: ConversationAgentRef): Promise<Schedule> {
    return this.writes.run(async () => {
      await this.loadState();
      const input = validateInput(params, "schedule_add");
      const schedule: Schedule = { id: randomUUID(), ...input, owner: scheduleOwner(owner), next_due_at: input.start };
      await this.commit(() => this.schedules.set(schedule.id, schedule));
      return cloneSchedule(schedule);
    });
  }

  async replace(params: Record<string, unknown>, actor: ConversationAgentRef): Promise<Schedule> {
    return this.writes.run(async () => {
      await this.loadState();
      const id = validateId(params.id);
      const input = validateInput(params, "schedule_replace");
      const current = this.ownedSchedule(id, actor);
      const replacement: Schedule = {
        id,
        ...input,
        owner: current.owner,
        next_due_at: input.start === current.start ? current.next_due_at : input.start,
      };
      await this.commit(() => this.schedules.set(id, replacement));
      return cloneSchedule(replacement);
    });
  }

  async remove(params: Record<string, unknown>, actor: ConversationAgentRef): Promise<string> {
    return this.writes.run(async () => {
      await this.loadState();
      const id = validateId(params.id);
      this.ownedSchedule(id, actor);
      await this.commit(() => this.schedules.delete(id));
      return id;
    });
  }

  async take(params: Record<string, unknown>, actor: ConversationAgentRef): Promise<Schedule> {
    return this.writes.run(async () => {
      await this.loadState();
      const id = validateId(params.id);
      const current = this.requiredSchedule(id);
      const previousOwner = ownerRef(current.owner);
      if (sameConversation(previousOwner, actor)) return cloneSchedule(current);
      const taken = { ...current, owner: scheduleOwner(actor) };
      await this.commit(() => this.schedules.set(id, taken));
      await this.timeline.publish({ type: "schedule_taken", scheduleId: id, previousOwner, owner: actor });
      return cloneSchedule(taken);
    });
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
    this.timer = this.scheduleTimer(() => void this.poll().catch((error) => this.report(error)), this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      this.cancelTimer(this.timer);
      this.timer = undefined;
    }
    const pendingStart = this.startInFlight;
    if (pendingStart) await pendingStart.catch(() => {});
    const pendingPoll = this.pollInFlight;
    if (pendingPoll) await pendingPoll.catch(() => {});
    await this.writes.idle().catch(() => {});
  }

  async poll(now = this.now()): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    const operation = this.writes.run(() => this.runPoll(now));
    this.pollInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.pollInFlight === operation) this.pollInFlight = undefined;
    }
  }

  private async runPoll(now: number): Promise<void> {
    try {
      await this.loadState();
      const previous = new Map(this.schedules);
      const due: Array<{ occurrenceId: string; schedule: Schedule; dueAt: string }> = [];
      for (const [id, schedule] of this.schedules) {
        const dueAt = schedule.next_due_at;
        if (dueAt === null || Date.parse(dueAt) > now) continue;
        due.push({ occurrenceId: randomUUID(), schedule, dueAt });
        this.schedules.set(id, {
          ...schedule,
          next_due_at: schedule.recurrence === null ? null : advanceRecurring(dueAt, schedule.recurrence, now),
        });
      }
      if (due.length > 0) {
        try {
          await this.saveState();
        } catch (error) {
          this.restore(previous);
          throw error;
        }
      }
      due.sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt) || left.schedule.prompt.localeCompare(right.schedule.prompt));
      for (const occurrence of due) {
        await this.timeline.publish({
          type: "schedule_fired",
          scheduleId: occurrence.schedule.id,
          occurrenceId: occurrence.occurrenceId,
          prompt: occurrence.schedule.prompt,
          dueAt: occurrence.dueAt,
          owner: ownerRef(occurrence.schedule.owner),
        });
      }
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    }
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    const raw = await readOptionalFile(this.schedulePath);
    if (raw !== undefined) {
      const file = validateScheduleFile(JSON.parse(raw) as unknown);
      this.schedules.clear();
      for (const schedule of file.schedules) this.schedules.set(schedule.id, schedule);
      this.stateLoaded = true;
      return;
    }

    const migrated = await this.readLegacySchedules();
    this.schedules.clear();
    for (const schedule of migrated) this.schedules.set(schedule.id, schedule);
    await this.saveState();
    this.stateLoaded = true;
    await rm(this.legacySchedulesPath, { force: true }).catch((error) => this.report(error));
    if (this.legacyStatePath !== undefined) await rm(this.legacyStatePath, { force: true }).catch((error) => this.report(error));
  }

  private async readLegacySchedules(): Promise<Schedule[]> {
    const raw = await readOptionalFile(this.legacySchedulesPath);
    if (raw === undefined) return [];
    const legacy = validateLegacyScheduleFile(JSON.parse(raw) as unknown);
    const state = await this.readLegacyState();
    const unique = new Map(legacy.schedules.map((row) => [legacyRowKey(row), row]));
    return [...unique].map(([key, row]) => ({
      id: randomUUID(),
      ...row,
      next_due_at: state.get(key) ?? state.get(oldLegacyRowKey(row)) ?? row.start,
    }));
  }

  private async readLegacyState(): Promise<Map<string, string | null>> {
    if (this.legacyStatePath === undefined) return new Map();
    const raw = await readOptionalFile(this.legacyStatePath);
    if (raw === undefined) return new Map();
    return new Map(validateLegacyStateFile(JSON.parse(raw) as unknown).rows.map((row) => [row.key, row.nextDueAt]));
  }

  private requiredSchedule(id: string): Schedule {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error(`Schedule ${id} does not exist`);
    return schedule;
  }

  private ownedSchedule(id: string, actor: ConversationAgentRef): Schedule {
    const schedule = this.requiredSchedule(id);
    if (!sameConversation(ownerRef(schedule.owner), actor)) throw new Error(`Schedule ${id} is not owned by this conversation`);
    return schedule;
  }

  private async commit(change: () => unknown): Promise<void> {
    const previous = new Map(this.schedules);
    change();
    try {
      await this.saveState();
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  private restore(previous: Map<string, Schedule>): void {
    this.schedules.clear();
    for (const [id, schedule] of previous) this.schedules.set(id, schedule);
  }

  private async saveState(): Promise<void> {
    await mkdir(path.dirname(this.schedulePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.schedulePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify({ version: 1, schedules: [...this.schedules.values()] } satisfies ScheduleFile, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_SCHEDULE_FILE_BYTES) throw new Error(`Schedules state exceeds ${MAX_SCHEDULE_FILE_BYTES} bytes`);
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.schedulePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
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
