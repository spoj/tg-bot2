import { lstat, mkdir, opendir, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { AgentManager } from "./agent.js";
import { appendSystemEvent } from "./events.js";
import { PiRunWorker, type PiRunResult } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import type { CancelRequest, SpawnRequest } from "./request-bus.js";
import { TASK_RUNNER_PROMPT } from "./task-protocol.js";
import { defined, errorMessage, isMissing } from "./util.js";

export type WorkspaceTaskWorker = {
  run(): Promise<PiRunResult>;
  stop(): Promise<void>;
  /** When the run last wrote output, and the tail of what it wrote. */
  activity(): { at: number; text: string };
};

export type WorkspaceTaskWorkerOptions = {
  workspace: string;
  /** Host-generated uuid identifying this run's directory under .pi/tasks/. */
  runId: string;
  /** The complete prompt from the spawn call. */
  prompt: string;
};

export type WorkspaceTaskWorkerFactory = (options: WorkspaceTaskWorkerOptions) => WorkspaceTaskWorker | Promise<WorkspaceTaskWorker>;

export type WorkspaceTasksOptions = {
  workspace: string;
  appRoot: string;
  bwrapPath?: string;
  /** Process-control seams injected by the composition root; the default worker factory passes them to the Pi run worker. */
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  workerFactory?: WorkspaceTaskWorkerFactory;
  /** Receives a completion followup per settled task, quoting the prompt and naming the run directory. */
  agent: Pick<AgentManager, "followup">;
  /** Consumes pending commands from system.jsonl before each settle followup, so task sends order before the completion message. */
  flush?: { flush(workspace: string): Promise<void> };
  heartbeatIntervalMs?: number;
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
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const MAX_QUOTE_LENGTH = 120;

type InFlightTask = {
  worker: WorkspaceTaskWorker;
  runId: string;
  prompt: string;
  startedAt: number;
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

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Runs agent-spawned background tasks: claims spawn tool calls into host-generated uuid
 * run directories under .pi/tasks/ (up to 8 concurrent; excess calls are retried
 * as slots free), records every settlement in system.jsonl, and sends the agent a
 * completion followup quoting the prompt. Cancel tool calls stop a run mid-flight.
 * Every started task settles exactly once — immediately on exit (any signal included),
 * or at the next boot via an aborted stamp when the host itself died mid-run.
 */
export class WorkspaceTasks {
  private readonly agent: WorkspaceTasksOptions["agent"];
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  private readonly stopGraceMs: number | undefined;
  private readonly workerFactory: WorkspaceTaskWorkerFactory;
  /** Consumes pending system.jsonl commands before the settle followup; assigned after construction to avoid a construction cycle with the request bus. */
  flush: WorkspaceTasksOptions["flush"];
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private readonly inFlight: InFlightTask[] = [];
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
    this.agent = options.agent;
    this.flush = options.flush;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Workspace task error", error));
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiRunWorker({
      workspace: workerOptions.workspace,
      appRoot: this.appRoot,
      ...defined({ bwrapPath: this.bwrapPath }),
      appendSystemPrompt: TASK_RUNNER_PROMPT,
      hostTools: "send",
      message: workerOptions.prompt,
      resume: false,
      sessionDir: `/workspace/.pi/tasks/${workerOptions.runId}/${SESSIONS_DIR}`,
      spawnProcess: this.spawnProcess,
      terminateProcessGroup: this.terminateProcessGroup,
      ...defined({ stopGraceMs: this.stopGraceMs }),
    }));
  }
  async start(): Promise<void> {
    if (this.running) {
      if (this.startInFlight) await this.startInFlight;
      return;
    }
    this.running = true;
    const initialStamp = this.stampAbortedRuns();
    this.startInFlight = initialStamp;
    try {
      await initialStamp;
    } finally {
      if (this.startInFlight === initialStamp) this.startInFlight = undefined;
    }
    if (!this.running) return;
    this.timer = this.schedule(() => this.heartbeat(), this.heartbeatIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
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

  /** Claims one spawn call; "pending" when the task slots are at capacity. */
  async handleSpawnRequest(record: SpawnRequest, workspace: string): Promise<"claimed" | "pending"> {
    const prompt = record.prompt;
    if (prompt.trim().length === 0 || prompt.length > MAX_TASK_BYTES) {
      await this.settleRejectedSpawn(workspace, record.runId, prompt);
      return "claimed";
    }
    if (this.inFlight.length >= MAX_CONCURRENT_TASKS) return "pending";
    await this.claimAndLaunch(workspace, record.runId, prompt);
    return "claimed";
  }

  /** Stops one running task; a command naming an unknown or settled run is a no-op. */
  async handleCancelRequest(record: CancelRequest, workspace: string): Promise<void> {
    const entry = this.inFlight.find((item) => item.runId === record.runId);
    if (entry === undefined) return;
    await appendSystemEvent(workspace, { type: "task_cancelled", runId: record.runId });
    await entry.worker.stop();
  }

  /** Records a spawn command whose prompt is unusable as claimed then failed, with a followup. */
  private async settleRejectedSpawn(workspace: string, runId: string, prompt: string): Promise<void> {
    const runDirectory = path.join(workspace, TASKS_DIR, runId);
    const reason = prompt.trim().length === 0
      ? "Task prompt must be a non-empty string"
      : `Task prompt exceeds ${MAX_TASK_BYTES} bytes`;
    await mkdir(path.join(runDirectory, SESSIONS_DIR), { recursive: true, mode: 0o700 });
    if (prompt.length > 0) {
      await writeFile(path.join(runDirectory, PROMPT_FILE), prompt, { encoding: "utf8", mode: 0o600 });
    }
    await appendSystemEvent(workspace, { type: "task_claimed", runId });
    await this.settleTask(workspace, { runId, prompt }, runDirectory, {
      code: null,
      signal: null,
      stderr: reason,
      stdout: "",
    });
  }

  /** Claims one spawn command into a fresh uuid run directory and launches its background run. */
  private async claimAndLaunch(workspace: string, runId: string, prompt: string): Promise<void> {
    const runDirectory = path.join(workspace, TASKS_DIR, runId);
    await mkdir(path.join(runDirectory, SESSIONS_DIR), { recursive: true, mode: 0o700 });
    await writeFile(path.join(runDirectory, PROMPT_FILE), prompt, { encoding: "utf8", mode: 0o600 });
    await appendSystemEvent(workspace, { type: "task_claimed", runId });
    let worker: WorkspaceTaskWorker;
    try {
      worker = await this.workerFactory({ workspace, runId, prompt });
    } catch (error) {
      await this.settleTask(workspace, { runId, prompt }, runDirectory, {
        code: null,
        signal: null,
        stderr: errorMessage(error),
        stdout: "",
      });
      return;
    }
    this.launchTask(workspace, { runId, prompt }, runDirectory, worker);
  }

  private launchTask(workspace: string, task: { runId: string; prompt: string }, runDirectory: string, worker: WorkspaceTaskWorker): void {
    this.inFlight.push({ worker, runId: task.runId, prompt: task.prompt, startedAt: this.now() });
    const settle = this.runAndSettle(workspace, task, runDirectory, worker);
    this.pendingSettles.add(settle);
    void settle
      .catch((error) => this.report(error))
      .finally(() => this.pendingSettles.delete(settle));
  }

  private async runAndSettle(
    workspace: string,
    task: { runId: string; prompt: string },
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
  }
  /**
   * Stamps aborted settles for runs the host left in flight when it died: the only way a
   * run dir can lack result.json at boot is an unsettled host crash. Idempotent — a
   * stamped dir never matches again.
   */
  private async stampAbortedRuns(): Promise<void> {
    const workspace = this.workspace;
    let tasksPath: string;
    try {
      tasksPath = await ensureTasksDirectory(workspace);
    } catch (error) {
      this.report(error);
      return;
    }
    const entries = await readDirEntries(tasksPath);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const runDirectory = path.join(tasksPath, entry.name);
      try {
        await lstat(path.join(runDirectory, RESULT_FILE));
      } catch (error) {
        if (!isMissing(error)) {
          this.report(error);
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
        await appendSystemEvent(workspace, {
          type: "task_settled",
          runId: entry.name,
          status: "aborted",
          exitCode: null,
        });
      }
    }
  }

  /** Records the outcome, appends the system event, and sends the agent a completion followup. */
  private async settleTask(
    workspace: string,
    task: { runId: string; prompt: string },
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
    await appendSystemEvent(workspace, {
      type: "task_settled",
      runId: task.runId,
      status,
      exitCode: result.code,
      ...defined({ stderr }),
    });
    if (this.flush) {
      try {
        await this.flush.flush(workspace);
      } catch (error) {
        this.report(error);
      }
    }
    const outcome = status === "done"
      ? "finished"
      : status === "failed"
        ? `failed (exit ${result.code ?? "unknown"})`
        : `aborted (${result.signal ?? "stopped"})`;
    const message = `Task "${truncate(task.prompt, MAX_QUOTE_LENGTH)}" ${outcome}. Run files: /workspace/.pi/tasks/${task.runId}/`;
    void this.agent.followup(message).catch((error) => this.report(error));
  }

  /** Sends one status followup while tasks run; silent when everything is idle. */
  private heartbeat(): void {
    if (this.inFlight.length === 0) return;
    const lines = this.inFlight.map((task) => this.heartbeatLine(task));
    const message = `Task heartbeat: ${this.inFlight.length} task(s) running.\n${lines.join("\n")}`;
    void this.agent.followup(message).catch((error) => this.report(error));
  }

  private heartbeatLine(task: InFlightTask): string {
    const { at, text } = task.worker.activity();
    const running = formatDuration(Math.max(0, this.now() - task.startedAt));
    const idle = at > 0 ? formatDuration(Math.max(0, this.now() - at)) : "unknown";
    const snippet = text.trim().length > 0 ? `; last output: "${truncate(text.trim(), MAX_QUOTE_LENGTH)}"` : "";
    return `- ${task.runId} "${truncate(task.prompt, 80)}" running ${running}, last activity ${idle} ago${snippet}`;
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt task processing.
    }
  }
}
