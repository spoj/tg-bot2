import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, rename, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { TaskTrigger } from "./agent-ref.js";
import type { WorkspaceTimeline } from "./events.js";
import type { AgentCredentials } from "./host-bridge.js";
import { PiWorker, type PiRunResult } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { TASK_RUNNER_PROMPT } from "./task-protocol.js";
import { closeQuietly, defined, errorMessage, isMissing, openPinnedDirectory } from "./util.js";

export type WorkspaceTaskWorker = {
  run(): Promise<PiRunResult>;
  steer(message: string): Promise<void>;
  stop(): Promise<void>;
  activity(): { at: number; text: string };
  /** Registers the callback fired once the initial prompt has been written to the worker. */
  onPrompted(callback: () => void): void;
};

export type WorkspaceTaskWorkerOptions = {
  workspace: string;
  runId: string;
  prompt: string;
  token: string;
};

export type WorkspaceTaskWorkerFactory = (options: WorkspaceTaskWorkerOptions) => WorkspaceTaskWorker | Promise<WorkspaceTaskWorker>;

export type WorkspaceTasksOptions = {
  workspace: string;
  timeline: WorkspaceTimeline;
  credentials: AgentCredentials;
  appRoot: string;
  bwrapPath?: string;
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  workerFactory?: WorkspaceTaskWorkerFactory;
  heartbeatIntervalMs?: number;
  hostSocketDir?: string;
  hostTimeline?: string;
  hostAttachments?: string;
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
export const TASK_PROMPT_EMPTY_MESSAGE = "Task prompt must be a non-empty string";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const MAX_QUOTE_LENGTH = 120;

type InFlightTask = {
  worker: WorkspaceTaskWorker;
  runId: string;
  trigger: TaskTrigger;
  token: string;
  prompt: string;
  startedAt: number;
  status: "starting" | "running";
  pendingSteers: string[];
  cancelled: boolean;
};

type QueuedSpawn = {
  runId: string;
  prompt: string;
  trigger: TaskTrigger;
};

type TaskRun = {
  runId: string;
  prompt: string;
  trigger: TaskTrigger;
  token: string;
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

async function writeTaskArtifact(directory: string, filename: string, content: string): Promise<void> {
  const pinned = await openPinnedDirectory(directory);
  const temporary = path.join(pinned.path, `.${filename}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(pinned.path, filename));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    await closeQuietly(pinned.handle);
  }
}


/**
 * Runs background tasks on demand. Queued work is process-local; launched runs
 * keep their artifacts under .pi/tasks and publish meaningful progress and
 * settlement updates independently of timeline durability.
 */
export class WorkspaceTasks {
  private readonly timeline: WorkspaceTimeline;
  private readonly credentials: AgentCredentials;
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  private readonly stopGraceMs: number | undefined;
  private readonly workerFactory: WorkspaceTaskWorkerFactory;
  private readonly heartbeatIntervalMs: number;
  private readonly hostSocketDir: string | undefined;
  private readonly hostTimeline: string | undefined;
  private readonly hostAttachments: string | undefined;
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
    this.credentials = options.credentials;
    this.bwrapPath = options.bwrapPath;
    this.spawnProcess = options.spawnProcess;
    this.terminateProcessGroup = options.terminateProcessGroup;
    this.stopGraceMs = options.stopGraceMs;
    this.timeline = options.timeline;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.hostSocketDir = options.hostSocketDir;
    this.hostTimeline = options.hostTimeline;
    this.hostAttachments = options.hostAttachments;
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Workspace task error", error));
    this.workerFactory = options.workerFactory ?? ((workerOptions) => {
      let onPrompted: (() => void) | undefined;
      const worker = new PiWorker({
        workspace: workerOptions.workspace,
        appRoot: this.appRoot,
        now: this.now,
        ...defined({ bwrapPath: this.bwrapPath }),
        taskRun: true,
        appendSystemPrompt: TASK_RUNNER_PROMPT,
        hostTools: "send",
        agentToken: workerOptions.token,
        sessionDir: `/workspace/.pi/tasks/${workerOptions.runId}/${SESSIONS_DIR}`,
        idleTimeoutMs: 0,
        spawnProcess: this.spawnProcess,
        terminateProcessGroup: this.terminateProcessGroup,
        ...defined({
          stopGraceMs: this.stopGraceMs,
          hostSocketDir: this.hostSocketDir,
          hostTimeline: this.hostTimeline,
          hostAttachments: this.hostAttachments,
        }),
        onInitialPromptWritten: () => onPrompted?.(),
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
        onPrompted: (callback: () => void) => {
          onPrompted = callback;
        },
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
    } catch (error) {
      this.running = false;
      throw error;
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

  /** Launches a background task for one spawn request; queues when all slots are busy. */
  async spawn(prompt: string, trigger: TaskTrigger, runId: string = randomUUID()): Promise<SpawnResult> {
    if (prompt.trim().length === 0) throw new Error(TASK_PROMPT_EMPTY_MESSAGE);
    if (Buffer.byteLength(prompt, "utf8") > MAX_TASK_BYTES) throw new Error(`Task prompt exceeds ${MAX_TASK_BYTES} bytes`);
    if (this.inFlight.length >= MAX_CONCURRENT_TASKS) {
      this.queued.push({ runId, prompt, trigger });
      return { runId, status: "queued" };
    }
    await this.claimAndLaunch(this.workspace, runId, prompt, trigger);
    return { runId, status: "launched" };
  }

  /** Stops one running task or dequeues a queued one; reports what happened. */
  async cancel(runId: string): Promise<"stopped" | "cancelled-queued" | "not-running"> {
    const entry = this.inFlight.find((item) => item.runId === runId);
    if (entry !== undefined) {
      entry.cancelled = true;
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

  /** Injects a mid-flight steering message into a running task; queues it until the initial prompt is written. */
  async steer(runId: string, message: string): Promise<"delivered" | "not-running"> {
    const entry = this.inFlight.find((item) => item.runId === runId);
    if (entry === undefined) return "not-running";
    if (entry.status === "starting") {
      entry.pendingSteers.push(message);
      return "delivered";
    }
    await entry.worker.steer(message);
    return "delivered";
  }

  private async claimAndLaunch(workspace: string, runId: string, prompt: string, trigger: TaskTrigger): Promise<void> {
    const runDirectory = path.join(workspace, TASKS_DIR, runId);
    await mkdir(path.join(runDirectory, SESSIONS_DIR), { recursive: true, mode: 0o700 });
    await writeTaskArtifact(runDirectory, PROMPT_FILE, prompt);
    const token = this.credentials.issue({ kind: "task", runId }, ["send"]);
    const task: TaskRun = { runId, prompt, trigger, token };
    let worker: WorkspaceTaskWorker;
    try {
      worker = await this.workerFactory({ workspace, runId, prompt, token });
    } catch (error) {
      this.credentials.revoke(token);
      await this.settleTask(workspace, task, runDirectory, {
        code: null,
        signal: null,
        stderr: errorMessage(error),
        stdout: "",
      });
      return;
    }
    this.launchTask(workspace, task, runDirectory, worker);
  }

  private launchTask(workspace: string, task: TaskRun, runDirectory: string, worker: WorkspaceTaskWorker): void {
    const entry: InFlightTask = {
      worker,
      runId: task.runId,
      trigger: task.trigger,
      token: task.token,
      prompt: task.prompt,
      startedAt: this.now(),
      status: "starting",
      pendingSteers: [],
      cancelled: false,
    };
    this.inFlight.push(entry);
    worker.onPrompted(() => {
      entry.status = "running";
      if (entry.cancelled) return;
      const pending = entry.pendingSteers.splice(0);
      void (async () => {
        for (const message of pending) {
          try {
            await entry.worker.steer(message);
          } catch (error) {
            this.report(error);
          }
        }
      })();
    });
    const settle = this.runAndSettle(workspace, task, runDirectory, worker);
    this.pendingSettles.add(settle);
    void settle.catch((error) => this.report(error)).finally(() => this.pendingSettles.delete(settle));
  }

  private async runAndSettle(
    workspace: string,
    task: TaskRun,
    runDirectory: string,
    worker: WorkspaceTaskWorker,
  ): Promise<void> {
    let result: PiRunResult;
    try {
      result = await worker.run();
    } catch (error) {
      result = { code: null, signal: null, stderr: errorMessage(error), stdout: "" };
    } finally {
      this.credentials.revoke(task.token);
      const index = this.inFlight.findIndex((entry) => entry.worker === worker);
      if (index >= 0) this.inFlight.splice(index, 1);
    }
    await this.settleTask(workspace, task, runDirectory, result);
    if (this.running) {
      const next = this.queued.shift();
      if (next) await this.claimAndLaunch(workspace, next.runId, next.prompt, next.trigger).catch((error) => this.report(error));
    }
  }

  /** Marks task directories left running across a host restart as aborted. */
  private async reconcileRuns(): Promise<void> {
    let tasksPath: string;
    try {
      tasksPath = await ensureTasksDirectory(this.workspace);
    } catch (error) {
      this.report(error);
      return;
    }
    for (const entry of await readDirEntries(tasksPath)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const runDirectory = path.join(tasksPath, entry.name);
      try {
        await lstat(path.join(runDirectory, RESULT_FILE));
        continue;
      } catch (error) {
        if (!isMissing(error)) {
          this.report(error);
          continue;
        }
      }
      try {
        await lstat(path.join(runDirectory, PROMPT_FILE));
      } catch (error) {
        if (isMissing(error)) {
          await rm(runDirectory, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        this.report(error);
        continue;
      }
      await writeTaskArtifact(runDirectory, RESULT_FILE, JSON.stringify({ status: "aborted" }));
    }
  }

  private async settleTask(
    workspace: string,
    task: TaskRun,
    runDirectory: string,
    result: PiRunResult,
  ): Promise<void> {
    const status: "done" | "failed" | "aborted" = result.signal !== null ? "aborted" : result.code === 0 ? "done" : "failed";
    const stderr = status === "failed" ? errorMessage(result.stderr) : undefined;
    if (status === "done" && result.stdout.trim().length > 0) {
      await writeTaskArtifact(runDirectory, OUTPUT_FILE, result.stdout);
    }
    await writeTaskArtifact(runDirectory, RESULT_FILE, JSON.stringify({
      status,
      exitCode: result.code,
      signal: result.signal,
      ...defined({ stderr }),
    }));
    await this.timeline.publish({
      type: "task_finished",
      runId: task.runId,
      trigger: task.trigger,
      prompt: task.prompt,
      status,
      exitCode: result.code,
      ...defined({ stderr }),
    });
  }

  private heartbeat(): void {
    if (this.inFlight.length === 0) return;
    const now = this.now();
    const groups = new Map<string, { trigger: Extract<TaskTrigger, { kind: "agent" }>; tasks: InFlightTask[] }>();
    for (const task of this.inFlight) {
      if (task.trigger.kind !== "agent") continue;
      const { chatId, threadId } = task.trigger.agent;
      const key = `${chatId}:${threadId}`;
      const group = groups.get(key) ?? { trigger: task.trigger, tasks: [] };
      group.tasks.push(task);
      groups.set(key, group);
    }
    for (const { trigger, tasks: running } of groups.values()) {
      const tasks = running.map((task) => {
        const { at, text } = task.worker.activity();
        const runningMs = Math.max(0, now - task.startedAt);
        const idleMs = at > 0 ? Math.max(0, now - at) : null;
        const lastOutput = text.trim().length > 0 ? truncate(text.trim(), MAX_QUOTE_LENGTH) : undefined;
        return { runId: task.runId, prompt: task.prompt, runningMs, idleMs, ...defined({ lastOutput }) };
      });
      this.timeline.notify({ type: "task_progress", trigger, tasks });
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
