import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleRecord = {
  id: string;
  chatId: number;
  dueAt: number;
  prompt: string;
  recurrence: Recurrence | null;
  createdAt: number;
};

export type ScheduleRequest = {
  when: string;
  prompt: string;
  recurring?: Recurrence;
};

export type SchedulerCallbacks = {
  run: (chatId: number, prompt: string) => Promise<string>;
  send: (chatId: number, text: string) => Promise<void>;
};

export type SchedulerOptions = SchedulerCallbacks & {
  dataDir: string;
  /** Override the trusted state file location, primarily for focused tests. */
  storagePath?: string;
  now?: () => number;
  idFactory?: () => string;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  logger?: (error: unknown) => void;
};

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MAX_TIMER_MS = 2_147_483_647;
const RECURRENCES = new Set<Recurrence>(["hourly", "daily", "weekly"]);

function recurrencePeriod(recurrence: Recurrence): number {
  if (recurrence === "hourly") return HOUR_MS;
  if (recurrence === "daily") return DAY_MS;
  return WEEK_MS;
}

function parseClock(value: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isInteger(minute) || minute > 59) return undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    return { hour: (hour % 12) + (meridiem === "pm" ? 12 : 0), minute };
  }
  if (hour > 23) return undefined;
  return { hour, minute };
}

function localAt(base: Date, dayOffset: number, clock: { hour: number; minute: number }): number {
  const result = new Date(base.getTime());
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() + dayOffset);
  result.setHours(clock.hour, clock.minute, 0, 0);
  return result.getTime();
}

function parseRelative(value: string, now: number): number | undefined {
  const match = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  if (!unit) return undefined;
  const multiplier = unit.startsWith("s") ? 1_000
    : unit.startsWith("m") ? 60_000
      : unit.startsWith("h") ? HOUR_MS
        : unit.startsWith("d") ? DAY_MS : WEEK_MS;
  return now + amount * multiplier;
}

/** Parse ISO, relative (for example, "in 2 hours"), tomorrow, and local clock forms. */
export function parseDueAt(input: string, now = Date.now()): number {
  if (typeof input !== "string" || !input.trim()) throw new Error("Schedule time must not be empty");
  if (!Number.isFinite(now)) throw new Error("Current time must be finite");
  const value = input.trim();
  const relative = parseRelative(value, now);
  if (relative !== undefined) return relative;

  const tomorrow = /^(?:tomorrow)(?:\s+(?:at\s+)?(.+))?$/i.exec(value);
  if (tomorrow) {
    if (!tomorrow[1]) {
      const result = new Date(now);
      result.setDate(result.getDate() + 1);
      return result.getTime();
    }
    const clock = parseClock(tomorrow[1]);
    if (!clock) throw new Error(`Invalid schedule time: ${input}`);
    return localAt(new Date(now), 1, clock);
  }

  const clockValue = /^(?:at\s+)?(.+)$/i.exec(value)?.[1] ?? value;
  const clock = parseClock(clockValue);
  if (clock) {
    const today = localAt(new Date(now), 0, clock);
    return today > now ? today : localAt(new Date(now), 1, clock);
  }

  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed) && Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid schedule time: ${input}`);
}

/** Advance a recurring due time beyond now, skipping every missed period. */
export function advanceDueAt(dueAt: number, recurrence: Recurrence, now: number): number {
  if (!Number.isFinite(dueAt) || !Number.isFinite(now)) throw new Error("Schedule times must be finite");
  const period = recurrencePeriod(recurrence);
  if (dueAt > now) return dueAt;
  return dueAt + (Math.floor((now - dueAt) / period) + 1) * period;
}

function isRecord(value: unknown): value is ScheduleRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && record.id.length > 0
    && typeof record.chatId === "number" && Number.isSafeInteger(record.chatId)
    && typeof record.dueAt === "number" && Number.isSafeInteger(record.dueAt) && record.dueAt >= 0
    && typeof record.prompt === "string" && record.prompt.length > 0
    && (record.recurrence === null || (typeof record.recurrence === "string" && RECURRENCES.has(record.recurrence as Recurrence)))
    && typeof record.createdAt === "number" && Number.isSafeInteger(record.createdAt) && record.createdAt >= 0;
}

function validateRecords(value: unknown): ScheduleRecord[] {
  if (!Array.isArray(value)) throw new Error("Scheduler state must be a JSON array");
  const ids = new Set<string>();
  const records: ScheduleRecord[] = [];
  for (const item of value) {
    if (!isRecord(item)) throw new Error("Scheduler state contains an invalid record");
    if (ids.has(item.id)) throw new Error(`Scheduler state contains duplicate ID: ${item.id}`);
    ids.add(item.id);
    records.push({ ...item });
  }
  return records;
}

export class Scheduler {
  private readonly storagePath: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly scheduleTimer: typeof setTimeout;
  private readonly cancelTimer: typeof clearTimeout;
  private readonly logger: (error: unknown) => void;
  private records: ScheduleRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operations: Promise<void> = Promise.resolve();
  private callbackTail: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  constructor(private readonly options: SchedulerOptions) {
    this.storagePath = options.storagePath ?? path.join(options.dataDir, "schedules.json");
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.scheduleTimer = options.setTimeout ?? setTimeout;
    this.cancelTimer = options.clearTimeout ?? clearTimeout;
    this.logger = options.logger ?? ((error) => console.error("Scheduler error", error));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  private ensureRunning(): void {
    if (!this.started || this.stopped) throw new Error("Scheduler is not running");
  }

  private async persist(records: ScheduleRecord[]): Promise<void> {
    const directory = path.dirname(this.storagePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(records, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.storagePath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async start(): Promise<void> {
    if (this.started && !this.stopped) return;
    if (this.stopped) throw new Error("Scheduler cannot be restarted");
    let loaded: ScheduleRecord[] = [];
    try {
      loaded = validateRecords(JSON.parse(await readFile(this.storagePath, "utf8")));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
    }
    if (this.stopped) return;
    this.records = loaded;
    this.started = true;
    await this.processDue(this.now());
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    if (this.timer !== undefined) {
      this.cancelTimer(this.timer);
      this.timer = undefined;
    }
    await this.operations;
    await this.callbackTail;
  }

  private armTimer(): void {
    if (!this.started || this.stopped) return;
    if (this.timer !== undefined) this.cancelTimer(this.timer);
    const nearest = this.records.reduce<number | undefined>((minimum, record) =>
      minimum === undefined || record.dueAt < minimum ? record.dueAt : minimum, undefined);
    if (nearest === undefined) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, nearest - this.now()));
    this.timer = this.scheduleTimer(() => {
      this.timer = undefined;
      void this.processDue(this.now()).catch((error) => this.logger(error));
    }, delay);
    const unref = (this.timer as unknown as { unref?: () => void }).unref;
    unref?.call(this.timer);
  }

  /** Process all records due at or before now. Public for deterministic tests. */
  async processDue(now = this.now()): Promise<void> {
    if (!this.started || this.stopped) return;
    let callbackWork: Promise<void> | undefined;
    await this.enqueue(async () => {
      if (!this.started || this.stopped) return;
      const due = this.records
        .filter((record) => record.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      if (due.length === 0) {
        this.armTimer();
        return;
      }
      const dueIds = new Set(due.map((record) => record.id));
      const next = this.records
        .filter((record) => !dueIds.has(record.id))
        .concat(due.flatMap((record) => record.recurrence
          ? [{ ...record, dueAt: advanceDueAt(record.dueAt, record.recurrence, now) }]
          : []));
      await this.persist(next);
      this.records = next;
      this.armTimer();
      callbackWork = this.callbackTail.then(async () => {
        for (const record of due) {
          try {
            const text = await this.options.run(record.chatId, record.prompt);
            if (text) await this.options.send(record.chatId, text);
          } catch (error) {
            this.logger(error);
          }
        }
      });
      this.callbackTail = callbackWork.then(() => undefined, () => undefined);
    });
    if (callbackWork) await callbackWork;
  }

  async schedule(chatId: number, request: ScheduleRequest): Promise<string> {
    this.ensureRunning();
    if (!Number.isSafeInteger(chatId)) throw new Error("Telegram chat ID must be a safe integer");
    if (!request.prompt.trim()) throw new Error("Schedule prompt must not be empty");
    const recurrence = request.recurring ?? null;
    if (recurrence !== null && !RECURRENCES.has(recurrence)) throw new Error(`Invalid recurrence: ${recurrence}`);
    return this.enqueue(async () => {
      const dueAt = parseDueAt(request.when, this.now());
      if (!Number.isSafeInteger(dueAt) || dueAt < 0) throw new Error("Schedule time must resolve to a safe timestamp");
      const record: ScheduleRecord = {
        id: this.idFactory(),
        chatId,
        dueAt,
        prompt: request.prompt,
        recurrence,
        createdAt: this.now(),
      };
      if (!record.id || typeof record.id !== "string") throw new Error("Schedule ID factory returned an invalid ID");
      if (this.records.some((candidate) => candidate.id === record.id)) throw new Error(`Schedule ID already exists: ${record.id}`);
      const next = [...this.records, record];
      await this.persist(next);
      this.records = next;
      this.armTimer();
      return `Scheduled ${record.id} for ${new Date(record.dueAt).toISOString()}${recurrence ? ` (${recurrence})` : ""}.`;
    });
  }

  async list(chatId: number): Promise<string> {
    this.ensureRunning();
    return this.enqueue(async () => {
      const records = this.records
        .filter((record) => record.chatId === chatId)
        .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      if (records.length === 0) return "No scheduled reminders.";
      return records.map((record) =>
        `${record.id} — ${new Date(record.dueAt).toISOString()} — ${record.prompt}${record.recurrence ? ` (${record.recurrence})` : ""}`,
      ).join("\n");
    });
  }

  async cancel(chatId: number, id: string): Promise<string> {
    this.ensureRunning();
    return this.enqueue(async () => {
      const record = this.records.find((candidate) => candidate.id === id && candidate.chatId === chatId);
      if (!record) return "No scheduled reminder found.";
      const next = this.records.filter((candidate) => candidate.id !== id);
      await this.persist(next);
      this.records = next;
      this.armTimer();
      return `Cancelled ${id}.`;
    });
  }

  /** Return a defensive snapshot for focused callers and tests. */
  getRecords(chatId?: number): ScheduleRecord[] {
    return this.records.filter((record) => chatId === undefined || record.chatId === chatId).map((record) => ({ ...record }));
  }
}

