import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendSystemEvent } from "./events.js";
import { TG_BOT_DIR, isMissing, openPinnedDirectory, readJsonl, type PinnedDirectory } from "./util.js";
import type { Recurrence, ScheduleRow } from "./schedule-protocol.js";

type ScheduleFile = {
  version: 1;
  schedules: ScheduleRow[];
};

type MaybePromise<T> = T | PromiseLike<T>;
type WorkspaceSchedulerOptions = {
  dataDir: string;
  run: (prompt: string) => MaybePromise<void>;
  pollIntervalMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: (error: unknown) => void;
};

type OpenRun = {
  runId: string;
  prompt: string;
  start: string;
  recurrence: Recurrence | null;
  dueAt: string;
};

type FoldedSchedules = {
  runs: Map<string, OpenRun>;
  open: Set<string>;
  rowRun: Map<string, string>;
  firedRows: Set<string>;
  lastDueAt: Map<string, string>;
};

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_TIMER_MS = 2_147_483_647;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const READ_FILE = fsConstants.O_RDONLY | NO_FOLLOW;
const SCHEDULES_FILE = "schedules.json";
const SYSTEM_FILE = "system.jsonl";
const MAX_SCHEDULE_PROMPT_LENGTH = 16 * 1024;
const UTC_ISO = /Z$/u;

function isUtcIso(value: unknown): value is string {
  return typeof value === "string" && UTC_ISO.test(value) && Number.isFinite(Date.parse(value));
}

function invalid(message: string): never {
  throw new Error(`Invalid schedules file: ${message}`);
}

function validateRow(value: unknown, index: number): ScheduleRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`row ${index} must be an object`);
  }
  const row = value as Record<string, unknown>;
  if (typeof row.prompt !== "string" || row.prompt.length === 0 || row.prompt.length > MAX_SCHEDULE_PROMPT_LENGTH) {
    invalid(`row ${index} has an invalid prompt`);
  }
  if (!isUtcIso(row.start)) invalid(`row ${index} has an invalid start`);
  if (row.recurrence !== null && row.recurrence !== "hourly" && row.recurrence !== "daily" && row.recurrence !== "weekly") {
    invalid(`row ${index} has an invalid recurrence`);
  }
  return { prompt: row.prompt, start: row.start, recurrence: row.recurrence as Recurrence | null };
}

function validateScheduleFile(value: unknown): ScheduleFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("root must be an object");
  const file = value as Record<string, unknown>;
  if (file.version !== 1) invalid("version must be 1");
  if (!Array.isArray(file.schedules)) invalid("schedules must be an array");
  return { version: 1, schedules: file.schedules.map(validateRow) };
}

function rowKey(row: { prompt: string; start: string; recurrence: Recurrence | null }): string {
  return JSON.stringify([row.prompt, row.start, row.recurrence]);
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
  const buffer = Buffer.allocUnsafe(stat.size);
  let bytesRead = 0;
  while (bytesRead < stat.size) {
    const result = await handle.read(buffer, bytesRead, stat.size - bytesRead, null);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** Replays schedule events into the folded state: open runs, per-row open mapping, fired rows, and last due times. */
function foldScheduleEvents(lines: string[]): FoldedSchedules {
  const state: FoldedSchedules = {
    runs: new Map(),
    open: new Set(),
    rowRun: new Map(),
    firedRows: new Set(),
    lastDueAt: new Map(),
  };
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    foldScheduleEvent(state, entry as Record<string, unknown>);
  }
  return state;
}

function foldScheduleEvent(state: FoldedSchedules, event: Record<string, unknown>): void {
  if (event.type === "schedule_run_scheduled") {
    if (
      typeof event.runId !== "string" || typeof event.prompt !== "string" ||
      typeof event.start !== "string" || typeof event.dueAt !== "string" ||
      (event.recurrence !== null && event.recurrence !== "hourly" && event.recurrence !== "daily" && event.recurrence !== "weekly")
    ) return;
    const run: OpenRun = {
      runId: event.runId,
      prompt: event.prompt,
      start: event.start,
      recurrence: event.recurrence as Recurrence | null,
      dueAt: event.dueAt,
    };
    const key = rowKey(run);
    const displaced = state.rowRun.get(key);
    if (displaced !== undefined) state.open.delete(displaced);
    state.runs.set(run.runId, run);
    state.open.add(run.runId);
    state.rowRun.set(key, run.runId);
    state.lastDueAt.set(key, run.dueAt);
    return;
  }
  if (event.type !== "schedule_run_fired" && event.type !== "schedule_run_cancelled") return;
  if (typeof event.runId !== "string") return;
  const run = state.runs.get(event.runId);
  if (!run) return;
  state.open.delete(event.runId);
  const key = rowKey(run);
  if (state.rowRun.get(key) === event.runId) state.rowRun.delete(key);
  if (event.type === "schedule_run_fired") state.firedRows.add(key);
}

/**
 * Event-sourced scheduler. schedules.json is agent-owned intent (prompt/start/recurrence
 * rows); the host never writes it. Each occurrence is a UUID-keyed run materialized in
 * system.jsonl: schedule_run_scheduled, schedule_run_fired, schedule_run_cancelled.
 * Every poll replays the log, reconciles it against the file (cancel vanished rows,
 * schedule new ones), and fires due runs.
 */
export class WorkspaceScheduler {
  private readonly dataDir: string;
  private readonly run: WorkspaceSchedulerOptions["run"];
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
    this.timer = this.schedule(() => {
      void this.poll().catch((error) => this.report(error));
    }, this.pollIntervalMs);
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

  /** Polls the bot's workspace; concurrent calls share one operation. */
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
    let metadata: PinnedDirectory | undefined;
    try {
      workspace = await openPinnedDirectory(path.join(this.dataDir, "workspace"));
      metadata = await openPinnedDirectory(path.join(workspace.path, TG_BOT_DIR), path.join(workspace.realPath, TG_BOT_DIR));
      await this.reconcile(workspace.path, metadata, now);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    } finally {
      if (metadata) await closeQuietly(metadata.handle);
      if (workspace) await closeQuietly(workspace.handle);
    }
  }

  private async reconcile(workspace: string, metadata: PinnedDirectory, now: number): Promise<void> {
    const rows = await this.readRows(metadata);
    if (rows === undefined) return;
    const state = foldScheduleEvents(await readJsonl(path.join(metadata.path, SYSTEM_FILE)).catch(() => []));
    const fileKeys = new Set(rows.map(rowKey));

    for (const [key, runId] of state.rowRun) {
      if (fileKeys.has(key)) continue;
      await appendSystemEvent(workspace, { type: "schedule_run_cancelled", runId });
      state.open.delete(runId);
      state.rowRun.delete(key);
    }

    for (const row of rows) {
      const key = rowKey(row);
      if (state.rowRun.has(key)) continue;
      if (row.recurrence === null && state.firedRows.has(key)) continue;
      const previous = state.lastDueAt.get(key);
      const dueAt = previous !== undefined && row.recurrence !== null
        ? advanceRecurring(previous, row.recurrence, now)
        : row.start;
      await this.scheduleRun(workspace, state, row, dueAt);
    }

    const due = [...state.open]
      .map((runId) => state.runs.get(runId))
      .filter((run): run is OpenRun => run !== undefined && Date.parse(run.dueAt) <= now)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.prompt.localeCompare(b.prompt));

    for (const run of due) {
      if (!state.open.has(run.runId)) continue;
      try {
        await this.run(run.prompt);
      } catch (error) {
        this.report(new Error(`Schedule run ${run.runId} was not completed`, { cause: error }));
        continue;
      }
      await appendSystemEvent(workspace, { type: "schedule_run_fired", runId: run.runId });
      state.open.delete(run.runId);
      const key = rowKey(run);
      if (state.rowRun.get(key) === run.runId) state.rowRun.delete(key);
      state.firedRows.add(key);
      if (run.recurrence !== null) {
        await this.scheduleRun(workspace, state, run, advanceRecurring(run.dueAt, run.recurrence, now));
      }
    }
  }

  private async scheduleRun(workspace: string, state: FoldedSchedules, row: { prompt: string; start: string; recurrence: Recurrence | null }, dueAt: string): Promise<void> {
    const run: OpenRun = { runId: randomUUID(), prompt: row.prompt, start: row.start, recurrence: row.recurrence, dueAt };
    await appendSystemEvent(workspace, {
      type: "schedule_run_scheduled",
      runId: run.runId,
      prompt: run.prompt,
      start: run.start,
      recurrence: run.recurrence,
      dueAt: run.dueAt,
    });
    const key = rowKey(run);
    const displaced = state.rowRun.get(key);
    if (displaced !== undefined) state.open.delete(displaced);
    state.runs.set(run.runId, run);
    state.open.add(run.runId);
    state.rowRun.set(key, run.runId);
    state.lastDueAt.set(key, run.dueAt);
  }

  private async readRows(metadata: PinnedDirectory): Promise<ScheduleRow[] | undefined> {
    const filePath = path.join(metadata.path, SCHEDULES_FILE);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let raw: string;
    try {
      handle = await open(filePath, READ_FILE);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("schedules.json is not a regular file");
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
