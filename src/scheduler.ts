import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sameConversation, type ConversationAgentRef } from "./agent-ref.js";
import type { WorkspaceTimeline } from "./events.js";
import { SerialQueue } from "./queue.js";
import type { Recurrence, Schedule, ScheduleInput } from "./schedule-protocol.js";
import { isMissing, readFileBounded } from "./util.js";

type PendingOccurrence = {
  occurrenceId: string;
  scheduleId: string;
  dueAt: string;
};

type ScheduleFile = { version: 1; schedules: Schedule[]; pending?: PendingOccurrence[] };

export type WorkspaceSchedulerOptions = {
  schedulePath: string;
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
const MAX_SCHEDULE_PROMPT_LENGTH = 16 * 1024;
const MAX_SCHEDULE_FILE_BYTES = 1024 * 1024;
const UTC_ISO = /Z$/u;

function isUtcIso(value: unknown): value is string {
  return typeof value === "string" && UTC_ISO.test(value) && Number.isFinite(Date.parse(value));
}

function invalid(message: string): never {
  throw new Error(`Invalid schedule: ${message}`);
}

function validateConversation(value: unknown, context: string): ConversationAgentRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${context} has an invalid owner`);
  const owner = value as Record<string, unknown>;
  if (owner.kind !== "conversation" || typeof owner.connectorId !== "string" || typeof owner.conversationKey !== "string") {
    invalid(`${context} has an invalid owner`);
  }
  if (owner.address === null || typeof owner.address !== "object" || Array.isArray(owner.address)) invalid(`${context} has an invalid owner address`);
  return {
    kind: "conversation",
    connectorId: owner.connectorId,
    conversationKey: owner.conversationKey,
    address: owner.address as Record<string, unknown>,
  };
}


function validateInput(value: unknown, context: string): ScheduleInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${context} must be an object`);
  const input = value as Record<string, unknown>;
  if (typeof input.prompt !== "string" || input.prompt.length === 0 || input.prompt.length > MAX_SCHEDULE_PROMPT_LENGTH) invalid(`${context} has an invalid prompt`);
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
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.schedules)) throw new Error("Invalid schedules state");
  const ids = new Set<string>();
  const schedules = root.schedules.map((value, index): Schedule => {
    const context = `row ${index}`;
    const input = validateInput(value, context);
    const row = value as Record<string, unknown>;
    const id = validateId(row.id);
    if (ids.has(id)) throw new Error(`Invalid schedules state: duplicate id ${id}`);
    ids.add(id);
    if (row.next_due_at !== null && !isUtcIso(row.next_due_at)) throw new Error(`Invalid schedules state: ${context} has an invalid next_due_at`);
    return {
      id,
      ...input,
      owner: validateConversation(row.owner, context),
      next_due_at: row.next_due_at as string | null,
    };
  });

  const rawPending = root.pending;
  if (rawPending !== undefined && !Array.isArray(rawPending)) throw new Error("Invalid schedules state: pending must be an array");
  const pendingIds = new Set<string>();
  const pending = (rawPending ?? []).map((value, index): PendingOccurrence => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid schedules state: pending row ${index}`);
    const row = value as Record<string, unknown>;
    if (typeof row.occurrenceId !== "string" || row.occurrenceId.length === 0) throw new Error(`Invalid schedules state: pending row ${index} has an invalid occurrenceId`);
    if (typeof row.scheduleId !== "string" || row.scheduleId.length === 0 || !ids.has(row.scheduleId)) throw new Error(`Invalid schedules state: pending row ${index} has an invalid scheduleId`);
    if (!isUtcIso(row.dueAt)) throw new Error(`Invalid schedules state: pending row ${index} has an invalid dueAt`);
    if (pendingIds.has(row.occurrenceId)) throw new Error(`Invalid schedules state: duplicate occurrenceId ${row.occurrenceId}`);
    pendingIds.add(row.occurrenceId);
    return { occurrenceId: row.occurrenceId, scheduleId: row.scheduleId, dueAt: row.dueAt };
  });
  const pendingScheduleIds = new Set<string>();
  for (const occurrence of pending) {
    if (pendingScheduleIds.has(occurrence.scheduleId)) throw new Error(`Invalid schedules state: duplicate pending schedule ${occurrence.scheduleId}`);
    pendingScheduleIds.add(occurrence.scheduleId);
  }
  return { version: 1, schedules, pending };
}


function advanceRecurring(dueAt: string, recurrence: Recurrence, now: number): string {
  const due = Date.parse(dueAt);
  if (due > now) return dueAt;
  const period = recurrence === "hourly" ? HOUR_MS : recurrence === "daily" ? DAY_MS : WEEK_MS;
  const periods = Math.floor((now - due) / period) + 1;
  return new Date(due + periods * period).toISOString();
}

function cloneSchedule(schedule: Schedule): Schedule {
  return { ...schedule, owner: { ...schedule.owner, address: { ...schedule.owner.address } } };
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
  private readonly schedulePath: string;
  private readonly timeline: WorkspaceTimeline;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly scheduleTimer: typeof setInterval;
  private readonly cancelTimer: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private readonly schedules = new Map<string, Schedule>();
  private readonly writes = new SerialQueue();
  private readonly pending = new Map<string, PendingOccurrence>();
  private stateLoaded = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceSchedulerOptions) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_TIMER_MS) throw new Error("Scheduler poll interval must be a positive timer-safe integer");
    this.schedulePath = path.resolve(options.schedulePath);
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
      const schedule: Schedule = { id: randomUUID(), ...input, owner, next_due_at: input.start };
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
      const nextDueAt = input.start !== current.start
        ? input.start
        : current.next_due_at === null && input.recurrence !== null
          ? advanceRecurring(input.start, input.recurrence, this.now())
          : current.next_due_at;
      const replacement: Schedule = { id, ...input, owner: current.owner, next_due_at: nextDueAt };
      await this.commit(() => {
        this.schedules.set(id, replacement);
        if (input.start !== current.start) this.pending.delete(id);
      });
      return cloneSchedule(replacement);
    });
  }


  async remove(params: Record<string, unknown>, actor: ConversationAgentRef): Promise<string> {
    return this.writes.run(async () => {
      await this.loadState();
      const id = validateId(params.id);
      this.ownedSchedule(id, actor);
      await this.commit(() => {
        this.schedules.delete(id);
        this.pending.delete(id);
      });
      return id;
    });
  }

  async take(params: Record<string, unknown>, actor: ConversationAgentRef): Promise<Schedule> {
    return this.writes.run(async () => {
      await this.loadState();
      const id = validateId(params.id);
      const current = this.requiredSchedule(id);
      if (sameConversation(current.owner, actor)) return cloneSchedule(current);
      const previousOwner = current.owner;
      const taken = { ...current, owner: actor };
      await this.commit(() => this.schedules.set(id, taken));
      await this.timeline.publish({ type: "schedule_taken", conversation: actor, scheduleId: id, previousOwner });
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
    if (this.startInFlight) await this.startInFlight.catch(() => {});
    if (this.pollInFlight) await this.pollInFlight.catch(() => {});
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
      const previousSchedules = new Map(this.schedules);
      const previousPending = new Map(this.pending);
      let addedPending = false;
      for (const [id, schedule] of this.schedules) {
        const dueAt = schedule.next_due_at;
        if (dueAt === null || Date.parse(dueAt) > now || this.pending.has(id)) continue;
        const occurrence: PendingOccurrence = { occurrenceId: randomUUID(), scheduleId: id, dueAt };
        this.pending.set(id, occurrence);
        addedPending = true;
      }
      if (addedPending) {
        try {
          await this.saveState();
        } catch (error) {
          this.restore(previousSchedules, previousPending);
          throw error;
        }
      }

      const due = [...this.pending.values()]
        .filter((pending) => Date.parse(pending.dueAt) <= now)
        .map((pending) => {
          const schedule = this.schedules.get(pending.scheduleId);
          if (!schedule) throw new Error(`Pending occurrence references missing schedule ${pending.scheduleId}`);
          return { pending, schedule };
        });
      due.sort((left, right) => Date.parse(left.pending.dueAt) - Date.parse(right.pending.dueAt)
        || left.schedule.prompt.localeCompare(right.schedule.prompt)
        || left.pending.occurrenceId.localeCompare(right.pending.occurrenceId));

      for (const occurrence of due) {
        if (!(await this.timeline.hasRecordId(occurrence.pending.occurrenceId))) {
          await this.timeline.publish({
            id: occurrence.pending.occurrenceId,
            type: "schedule_fired",
            conversation: occurrence.schedule.owner,
            scheduleId: occurrence.schedule.id,
            occurrenceId: occurrence.pending.occurrenceId,
            prompt: occurrence.schedule.prompt,
            dueAt: occurrence.pending.dueAt,
          });
        }

        const beforeAcknowledgementSchedules = new Map(this.schedules);
        const beforeAcknowledgementPending = new Map(this.pending);
        this.pending.delete(occurrence.pending.scheduleId);
        const current = this.schedules.get(occurrence.pending.scheduleId);
        if (!current) throw new Error(`Pending occurrence references missing schedule ${occurrence.pending.scheduleId}`);
        this.schedules.set(current.id, {
          ...current,
          next_due_at: current.recurrence === null
            ? null
            : advanceRecurring(occurrence.pending.dueAt, current.recurrence, now),
        });
        try {
          await this.saveState();
        } catch (error) {
          this.restore(beforeAcknowledgementSchedules, beforeAcknowledgementPending);
          throw error;
        }
      }
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    }
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    const raw = await readOptionalFile(this.schedulePath);
    this.schedules.clear();
    this.pending.clear();
    if (raw !== undefined) {
      const file = validateScheduleFile(JSON.parse(raw) as unknown);
      for (const schedule of file.schedules) this.schedules.set(schedule.id, schedule);
      for (const occurrence of file.pending ?? []) this.pending.set(occurrence.scheduleId, occurrence);
    }
    if (raw === undefined) await this.saveState();
    this.stateLoaded = true;
  }

  private requiredSchedule(id: string): Schedule {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error(`Schedule ${id} does not exist`);
    return schedule;
  }

  private ownedSchedule(id: string, actor: ConversationAgentRef): Schedule {
    const schedule = this.requiredSchedule(id);
    if (!sameConversation(schedule.owner, actor)) throw new Error(`Schedule ${id} is not owned by this conversation`);
    return schedule;
  }

  private async commit(change: () => unknown): Promise<void> {
    const previousSchedules = new Map(this.schedules);
    const previousPending = new Map(this.pending);
    change();
    try {
      await this.saveState();
    } catch (error) {
      this.restore(previousSchedules, previousPending);
      throw error;
    }
  }

  private restore(previousSchedules: Map<string, Schedule>, previousPending: Map<string, PendingOccurrence>): void {
    this.schedules.clear();
    for (const [id, schedule] of previousSchedules) this.schedules.set(id, schedule);
    this.pending.clear();
    for (const [scheduleId, occurrence] of previousPending) this.pending.set(scheduleId, occurrence);
  }


  private async saveState(): Promise<void> {
    await mkdir(path.dirname(this.schedulePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.schedulePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify({ version: 1, schedules: [...this.schedules.values()], pending: [...this.pending.values()] } satisfies ScheduleFile, null, 2)}\n`;
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
