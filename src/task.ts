import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, readFile, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { WorkspaceEventLog } from "./events.js";
import { PiWorker, type PiRunResult } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { TASK_RUNNER_PROMPT } from "./task-protocol.js";
import { defined, errorMessage, isMissing } from "./util.js";

export type WorkspaceTaskWorker = {
  run(): Promise<PiRunResult>;
  steer(message: string): Promise<void>;
  stop(): Promise<void>;
  activity(): { at: number; text: string };
};

export type WorkspaceTaskWorkerOptions = {
  workspace: string;
  runId: string;
  prompt: string;
};

export type WorkspaceTaskWorkerFactory = (options: WorkspaceTaskWorkerOptions) => WorkspaceTaskWorker | Promise<WorkspaceTaskWorker>;

export type WorkspaceTasksOptions = {
  workspace: string;
  events: WorkspaceEventLog;
  appRoot: string;
  bwrapPath?: string;
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  busyTimeoutMs?: number;
  workerFactory?: WorkspaceTaskWorkerFactory;
  heartbeatIntervalMs?: number;
  /** Host socket dir and events log bind-mounted into task sandboxes. */
  hostSocketDir?: string;
  hostEventsLog?: string;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: (error: unknown) => void;
};

const MAX_TIMER_MS = 2_147_483_647;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_CONCURRENT_TASKS = 8;
const TASKS_DIR = path.join(".pi", "tasks");
const SESSIONS_DIR = "sessions";
const PROMPT_FILE = "prompt.txt";
const OUTPUT_FILE = "output.md";
const RESULT_FILE = "result.json";
export const DEFAULT_TASK_BUSY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const TASK_BUSY_TIMEOUT_MESSAGE =
  "Interrupted: Operation took over 15 minutes with no progress. If running long-running commands, consider running them in the background, redirecting output to a file, and checking progress periodically.";
export const TASK_PROMPT_EMPTY_MESSAGE = "Task prompt must be a non-empty string";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const MAX_QUOTE_LENGTH = 120;

type InFlightTask = {
  worker: WorkspaceTaskWorker;
  runId: string;
  origin?: string | undefined;
  prompt: string;
  startedAt: number;
};

type QueuedSpawn = {
  runId: string;
  prompt: string;
  origin?: string | undefined;
};

export type SpawnResult = {
  runId: string;
  status: "launched" | "queued";
};

async function readDirEntries(directory: string): Promise<Dirent[]> {
  const handle = await opendir(directory);
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = await handle.read();
      if (entry === null) break;
      entries.push(entry);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return entries;
}

/** Ensures the tasks root is a real directory, replacing a planted symlink. */
async function ensureTasksDirectory(workspace: string): Promise<string> {
  const directory = path.join(workspace, TASKS_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Tasks path must be a real directory: ${directory}`);
  }
  return directory;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function parseSettledResult(raw: string): { status: "done" | "failed" | "aborted"; exitCode: number | null; stderr?: string | undefined } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record.status === "done" || record.status === "failed") {
        return {
          status: record.status,
          exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
          ...(typeof record.stderr === "string" && record.stderr.length > 0 ? { stderr: record.stderr } : {}),
        };
      }
    }
  } catch {
    // Unparseable result is treated as aborted.
  }
  return { status: "aborted", exitCode: null };
}

/**
 * Runs agent-spawned background tasks synchronously on demand: the host mints a
 * uuid runId, creates the run directory under .pi/tasks/, launches a fresh Pi
 * worker (up to 8 concurrent; excess spawns queue in memory and launch as slots
 * free), records every settlement in the events log, and sends the agent a
 * completion followup quoting the prompt. Cancel and steer call in directly and
 * report their outcome. A run settles exactly once — immediately on exit (any
 * signal included), or at the next boot when the host reconciles run directories
 * against the events log (aborted stamp for crash-mid-run, terminal repair for
 * crash-mid-settle, re-launch for fired schedule occurrences lost mid-fire).
 */
export class WorkspaceTasks {
  private readonly events: WorkspaceEventLog;
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  private readonly stopGraceMs: number | undefined;
  private readonly busyTimeoutMs: number | undefined;
  private readonly workerFactory: WorkspaceTaskWorkerFactory;
  private readonly heartbeatIntervalMs: number;
  private readonly hostSocketDir: string | undefined;
  private readonly hostEventsLog: string | undefined;
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private readonly inFlight: InFlightTask[] = [];
  private readonly queued: QueuedSpawn[] = [];
  private readonly pendingSettles = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceTasksOptions) {
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs > MAX_TIMER_MS) {
      throw new Error("Task heartbeat interval must be a positive timer-safe integer");
    }
    this.workspace = path.resolve(options.workspace);
    this.appRoot = path.resolve(options.appRoot);
    this.bwrapPath = options.bwrapPath;
    this.spawnProcess = options.spawnProcess;
    this.terminateProcessGroup = options.terminateProcessGroup;
    this.stopGraceMs = options.stopGraceMs;
    this.busyTimeoutMs = options.busyTimeoutMs;
    this.events = options.events;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.hostSocketDir = options.hostSocketDir;
    this.hostEventsLog = options.hostEventsLog;
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Workspace task error", error));
    this.workerFactory = options.workerFactory ?? ((workerOptions) => {
      const worker = new PiWorker({
        workspace: workerOptions.workspace,
        appRoot: this.appRoot,
        ...defined({ bwrapPath: this.bwrapPath }),
        appendSystemPrompt: TASK_RUNNER_PROMPT,
        hostTools: "send,start_browser",
        agentOrigin: `task:${workerOptions.runId}`,
        resume: false,
        sessionDir: `/workspace/.pi/tasks/${workerOptions.runId}/${SESSIONS_DIR}`,
        idleTimeoutMs: 0,
        spawnProcess: this.spawnProcess,
        terminateProcessGroup: this.terminateProcessGroup,
        ...defined({
          stopGraceMs: this.stopGraceMs,
          busyTimeoutMs: this.busyTimeoutMs ?? DEFAULT_TASK_BUSY_TIMEOUT_MS,
          busyTimeoutMessage: TASK_BUSY_TIMEOUT_MESSAGE,
          hostSocketDir: this.hostSocketDir,
          hostEventsLog: this.hostEventsLog,
        }),
      });
      return {
        run: async () => {
          await worker.start();
          await worker.prompt(workerOptions.prompt);
          const result = await worker.waitForSettled();
          await worker.close();
          return result;
        },
        steer: (message: string) => worker.prompt(message, "steer"),
        stop: () => worker.stop(),
        activity: () => worker.activity(),
      };
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      if (this.startInFlight) await this.startInFlight;
      return;
    }
    this.running = true;
    const initialReconcile = this.reconcileRuns();
    this.startInFlight = initialReconcile;
    try {
      await initialReconcile;
    } finally {
      if (this.startInFlight === initialReconcile) this.startInFlight = undefined;
    }
    if (!this.running) return;
    this.timer = this.schedule(() => this.heartbeat(), this.heartbeatIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.queued.length = 0;
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    const stops = this.inFlight.map(({ worker }) => worker.stop().catch((error) => this.report(error)));
    await Promise.all(stops);
    for (;;) {
      const pending: Promise<void>[] = [];
      if (this.startInFlight) pending.push(this.startInFlight);
      for (const settle of [...this.pendingSettles]) pending.push(settle.catch(() => {}));
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /** Launches a background task for one spawn tool call; queues when all slots are busy. */
  async spawn(prompt: string, origin?: string | undefined, runId: string = randomUUID()): Promise<SpawnResult> {
    if (prompt.trim().length === 0) throw new Error(TASK_PROMPT_EMPTY_MESSAGE);
    if (prompt.length > MAX_TASK_BYTES) throw new Error(`Task prompt exceeds ${MAX_TASK_BYTES} bytes`);
    if (this.inFlight.length >= MAX_CONCURRENT_TASKS) {
      this.queued.push({ runId, prompt, origin });
      return { runId, status: "queued" };
    }
    await this.claimAndLaunch(this.workspace, runId, prompt, origin);
    return { runId, status: "launched" };
  }

  /** Stops one running task or dequeues a queued one; reports what happened. */
  async cancel(runId: string): Promise<"stopped" | "cancelled-queued" | "not-running"> {
    const entry = this.inFlight.find((item) => item.runId === runId);
    if (entry !== undefined) {
      await entry.worker.stop();
      return "stopped";
    }
    const queuedIndex = this.queued.findIndex((item) => item.runId === runId);
    if (queuedIndex >= 0) {
      this.queued.splice(queuedIndex, 1);
      return "cancelled-queued";
    }
    return "not-running";
  }

  /** Injects a mid-flight steering message into a running task. */
  async steer(runId: string, message: string): Promise<"delivered" | "not-running"> {
    const entry = this.inFlight.find((item) => item.runId === runId);
    if (entry === undefined) return "not-running";
    await entry.worker.steer(message);
    return "delivered";
  }

  /** Launches a background task in a fresh uuid run directory. */
  private async claimAndLaunch(workspace: string, runId: string, prompt: string, origin?: string | undefined): Promise<void> {
    const runDirectory = path.join(workspace, TASKS_DIR, runId);
    await mkdir(path.join(runDirectory, SESSIONS_DIR), { recursive: true, mode: 0o700 });
    await writeFile(path.join(runDirectory, PROMPT_FILE), prompt, { encoding: "utf8", mode: 0o600 });
    let worker: WorkspaceTaskWorker;
    try {
      worker = await this.workerFactory({ workspace, runId, prompt });
    } catch (error) {
      await this.settleTask(workspace, { runId, prompt, origin }, runDirectory, {
        code: null,
        signal: null,
        stderr: errorMessage(error),
        stdout: "",
      });
      return;
    }
    this.launchTask(workspace, { runId, prompt, origin }, runDirectory, worker);
  }

  private launchTask(workspace: string, task: { runId: string; prompt: string; origin?: string | undefined }, runDirectory: string, worker: WorkspaceTaskWorker): void {
    this.inFlight.push({ worker, runId: task.runId, origin: task.origin, prompt: task.prompt, startedAt: this.now() });
    const settle = this.runAndSettle(workspace, task, runDirectory, worker);
    this.pendingSettles.add(settle);
    void settle
      .catch((error) => this.report(error))
      .finally(() => this.pendingSettles.delete(settle));
  }

  private async runAndSettle(
    workspace: string,
    task: { runId: string; prompt: string; origin?: string | undefined },
    runDirectory: string,
    worker: WorkspaceTaskWorker,
  ): Promise<void> {
    let result: PiRunResult;
    try {
      result = await worker.run();
    } catch (error) {
      result = { code: null, signal: null, stderr: errorMessage(error), stdout: "" };
    } finally {
      const index = this.inFlight.findIndex((entry) => entry.worker === worker);
      if (index >= 0) this.inFlight.splice(index, 1);
    }
    await this.settleTask(workspace, task, runDirectory, result);
    if (this.running) {
      const next = this.queued.shift();
      if (next !== undefined) {
        await this.claimAndLaunch(workspace, next.runId, next.prompt, next.origin).catch((error) => this.report(error));
      }
    }
  }

  /**
   * Reconciles run directories against the events log at boot. The events log is
   * authoritative for settlement; result.json is agent-writable and only consulted
   * when the terminal event is missing:
   * - runId already settled in the log → nothing to do;
   * - result.json present without a terminal → re-emit the settle event (crash between result write and terminal);
   * - prompt.txt without result.json → the run died mid-flight: stamp it aborted;
   * - neither file → leftover empty dir, delete.
   * Fired schedule occurrences with neither a terminal nor a run directory were
   * lost between firing and spawning: launch them now.
   */
  private async reconcileRuns(): Promise<void> {
    const records = await this.events.readAll();
    const settledRunIds = new Set<string>();
    const firedRuns = new Map<string, string>();
    for (const record of records) {
      if (record.type === "task_settled" && typeof record.runId === "string" && record.runId.length > 0) {
        settledRunIds.add(record.runId);
      } else if (record.type === "schedule_run_fired" && typeof record.runId === "string" && typeof record.prompt === "string") {
        firedRuns.set(record.runId, record.prompt);
      }
    }
    let tasksPath: string;
    try {
      tasksPath = await ensureTasksDirectory(this.workspace);
    } catch (error) {
      this.report(error);
      return;
    }
    await this.reconcileRunDirectories(tasksPath, settledRunIds);
    await this.recoverFiredOccurrences(tasksPath, settledRunIds, firedRuns);
  }

  private async reconcileRunDirectories(tasksPath: string, settledRunIds: Set<string>): Promise<void> {
    for (const entry of await readDirEntries(tasksPath)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (settledRunIds.has(entry.name)) continue;
      const runDirectory = path.join(tasksPath, entry.name);
      let resultRaw: string | undefined;
      try {
        resultRaw = await readFile(path.join(runDirectory, RESULT_FILE), "utf8");
      } catch (error) {
        if (!isMissing(error)) {
          this.report(error);
          continue;
        }
      }
      if (resultRaw !== undefined) {
        const prompt = await readFile(path.join(runDirectory, PROMPT_FILE), "utf8").catch(() => undefined);
        const result = parseSettledResult(resultRaw);
        await this.events.emit({
          type: "task_settled",
          runId: entry.name,
          ...(prompt !== undefined ? { prompt } : {}),
          status: result.status,
          exitCode: result.exitCode,
          ...defined({ stderr: result.stderr }),
        });
        continue;
      }
      try {
        await lstat(path.join(runDirectory, PROMPT_FILE));
      } catch (promptError) {
        if (isMissing(promptError)) {
          await rm(runDirectory, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        this.report(promptError);
        continue;
      }
      await writeFile(path.join(runDirectory, RESULT_FILE), JSON.stringify({ status: "aborted" }), { encoding: "utf8", mode: 0o600 });
      await this.events.emit({
        type: "task_settled",
        runId: entry.name,
        status: "aborted",
        exitCode: null,
      });
    }
  }

  private async recoverFiredOccurrences(tasksPath: string, settledRunIds: Set<string>, firedRuns: Map<string, string>): Promise<void> {
    for (const [runId, prompt] of firedRuns) {
      if (settledRunIds.has(runId)) continue;
      try {
        await lstat(path.join(tasksPath, runId));
        continue;
      } catch (error) {
        if (!isMissing(error)) {
          this.report(error);
          continue;
        }
      }
      await this.spawn(prompt, undefined, runId).catch((error) => this.report(error));
    }
  }

  /** Records the outcome, appends the system event, and sends the agent a completion followup. */
  private async settleTask(
    workspace: string,
    task: { runId: string; prompt: string; origin?: string | undefined },
    runDirectory: string,
    result: PiRunResult,
  ): Promise<void> {
    const status: "done" | "failed" | "aborted" = result.signal !== null ? "aborted" : result.code === 0 ? "done" : "failed";
    const stderr = status === "failed" ? errorMessage(result.stderr) : undefined;
    if (status === "done" && result.stdout.trim().length > 0) {
      await writeFile(path.join(runDirectory, OUTPUT_FILE), result.stdout, { encoding: "utf8", mode: 0o600 });
    }
    await writeFile(path.join(runDirectory, RESULT_FILE), JSON.stringify({
      status,
      exitCode: result.code,
      signal: result.signal,
      ...defined({ stderr }),
    }), { encoding: "utf8", mode: 0o600 });
    await this.events.emit({
      type: "task_settled",
      runId: task.runId,
      prompt: task.prompt,
      status,
      exitCode: result.code,
      ...defined({ origin: task.origin, stderr }),
    });
  }

  /** Emits a task_progress event while tasks run; silent when everything is idle. */
  private heartbeat(): void {
    if (this.inFlight.length === 0) return;
    const now = this.now();
    const byOrigin = new Map<string | undefined, InFlightTask[]>();
    for (const task of this.inFlight) {
      const list = byOrigin.get(task.origin) ?? [];
      list.push(task);
      byOrigin.set(task.origin, list);
    }
    for (const [origin, tasksList] of byOrigin) {
      const tasks = tasksList.map((task) => {
        const { at, text } = task.worker.activity();
        const runningMs = Math.max(0, now - task.startedAt);
        const idleMs = at > 0 ? Math.max(0, now - at) : null;
        const lastOutput = text.trim().length > 0 ? truncate(text.trim(), MAX_QUOTE_LENGTH) : undefined;
        return {
          runId: task.runId,
          prompt: task.prompt,
          runningMs,
          idleMs,
          ...defined({ lastOutput }),
        };
      });
      void this.events.publish({ type: "task_progress", ...defined({ origin }), tasks }).catch((error) => this.report(error));
    }
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt task processing.
    }
  }
}
