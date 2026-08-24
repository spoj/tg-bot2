import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { conversationAgent, sameConversation, type ConversationAgentRef } from "./agent-ref.js";
import type { WorkspaceTimeline } from "./events.js";
import type { AgentCredentials } from "./host-bridge.js";
import { PiWorker, type PiRunResult } from "./pi-worker.js";
import { SerialQueue } from "./queue.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { TASK_RUNNER_PROMPT } from "./task-protocol.js";
import { closeQuietly, defined, errorMessage, isMissing, openPinnedDirectory, readFileBounded } from "./util.js";

export type WorkspaceTaskWorker = {
  run(): Promise<PiRunResult>;
  steer(message: string): Promise<void>;
  stop(): Promise<void>;
  activity(): { at: number; text: string };
  onPrompted(callback: () => void): void;
};

export type TaskLaunchInput = {
  prompt: string;
  model?: string | undefined;
  thinking?: string | undefined;
};

export type WorkspaceTaskWorkerOptions = TaskLaunchInput & {
  workspace: string;
  runId: string;
  token: string;
  continuation: boolean;
};

export type WorkspaceTaskWorkerFactory = (options: WorkspaceTaskWorkerOptions) => WorkspaceTaskWorker | Promise<WorkspaceTaskWorker>;

export type WorkspaceTasksOptions = {
  workspace: string;
  statePath: string;
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

type TaskStatus = "queued" | "running" | "done" | "failed" | "aborted";
type TaskOwner = { chat_id: number; message_thread_id?: number | undefined };
type TaskState = { id: string; owner: TaskOwner; status: TaskStatus; updated_at: string };
type TaskStateFile = { version: 1; tasks: TaskState[] };

type InFlightTask = {
  worker: WorkspaceTaskWorker;
  runId: string;
  owner: ConversationAgentRef;
  token: string;
  prompt: string;
  startedAt: number;
  status: "starting" | "running";
  pendingSteers: string[];
  cancelled: boolean;
};

type QueuedTask = TaskLaunchInput & {
  runId: string;
  owner: ConversationAgentRef;
  continuation: boolean;
};

type TaskRun = TaskLaunchInput & {
  runId: string;
  owner: ConversationAgentRef;
  token: string;
};

export type SpawnResult = {
  runId: string;
  status: "launched" | "queued";
};

const MAX_TIMER_MS = 2_147_483_647;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_CONCURRENT_TASKS = 8;
const MAX_TASK_STATE_BYTES = 1024 * 1024;
const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const TASKS_DIR = path.join(".pi", "tasks");
const SESSIONS_DIR = "sessions";
const OUTPUT_FILE = "output.md";
const LEGACY_PROMPT_FILE = "prompt.txt";
const LEGACY_RESULT_FILE = "result.json";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const READ_FILE = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
export const TASK_PROMPT_EMPTY_MESSAGE = "Task prompt must be a non-empty string";

function validateLaunchInput(value: unknown): TaskLaunchInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Task request must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) throw new Error(TASK_PROMPT_EMPTY_MESSAGE);
  if (Buffer.byteLength(input.prompt, "utf8") > MAX_TASK_BYTES) throw new Error(`Task prompt exceeds ${MAX_TASK_BYTES} bytes`);
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.trim().length === 0)) throw new Error("Task model must be a non-empty string");
  if (input.thinking !== undefined && (typeof input.thinking !== "string" || input.thinking.trim().length === 0)) throw new Error("Task thinking must be a non-empty string");
  return {
    prompt: input.prompt,
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    ...(typeof input.thinking === "string" ? { thinking: input.thinking } : {}),
  };
}

function validateOwner(value: unknown): TaskOwner {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tasks state owner");
  const owner = value as Record<string, unknown>;
  if (typeof owner.chat_id !== "number" || !Number.isSafeInteger(owner.chat_id)) throw new Error("Invalid tasks state owner.chat_id");
  if (owner.message_thread_id !== undefined && (typeof owner.message_thread_id !== "number" || !Number.isSafeInteger(owner.message_thread_id))) {
    throw new Error("Invalid tasks state owner.message_thread_id");
  }
  return { chat_id: owner.chat_id, ...(typeof owner.message_thread_id === "number" ? { message_thread_id: owner.message_thread_id } : {}) };
}

function validateTaskStateFile(value: unknown): TaskStateFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tasks state");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.tasks)) throw new Error("Invalid tasks state");
  const ids = new Set<string>();
  const tasks = file.tasks.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tasks state row");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0 || ids.has(row.id)) throw new Error("Invalid tasks state id");
    ids.add(row.id);
    if (row.status !== "queued" && row.status !== "running" && row.status !== "done" && row.status !== "failed" && row.status !== "aborted") {
      throw new Error("Invalid tasks state status");
    }
    if (typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) throw new Error("Invalid tasks state updated_at");
    return { id: row.id, owner: validateOwner(row.owner), status: row.status as TaskStatus, updated_at: row.updated_at };
  });
  return { version: 1, tasks };
}

function taskOwner(owner: ConversationAgentRef): TaskOwner {
  return { chat_id: owner.chatId, ...(owner.threadId === 0 ? {} : { message_thread_id: owner.threadId }) };
}

function ownerRef(owner: TaskOwner): ConversationAgentRef {
  return conversationAgent(owner.chat_id, owner.message_thread_id ?? 0);
}

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "aborted";
}

async function ensureRealDirectory(directory: string, label: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function writeTaskOutput(directory: string, content: string): Promise<void> {
  const pinned = await openPinnedDirectory(directory);
  const temporary = path.join(pinned.path, `.${OUTPUT_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(pinned.path, OUTPUT_FILE));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    await closeQuietly(pinned.handle);
  }
}

export class WorkspaceTasks {
  private readonly timeline: WorkspaceTimeline;
  private readonly credentials: AgentCredentials;
  private readonly workspace: string;
  private readonly statePath: string;
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
  private readonly operations = new SerialQueue();
  private readonly taskState = new Map<string, TaskState>();
  private readonly inFlight: InFlightTask[] = [];
  private readonly queued: QueuedTask[] = [];
  private readonly pendingSettles = new Set<Promise<void>>();
  private stateLoaded = false;
  private timer: NodeJS.Timeout | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceTasksOptions) {
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs > MAX_TIMER_MS) {
      throw new Error("Task heartbeat interval must be a positive timer-safe integer");
    }
    this.workspace = path.resolve(options.workspace);
    this.statePath = path.resolve(options.statePath);
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
        ...defined({
          bwrapPath: this.bwrapPath,
          model: workerOptions.model,
          thinkingLevel: workerOptions.thinking,
        }),
        taskRun: true,
        appendSystemPrompt: TASK_RUNNER_PROMPT,
        hostTools: "annotate",
        agentToken: workerOptions.token,
        sessionDir: `/workspace/.pi/tasks/${workerOptions.runId}/${SESSIONS_DIR}`,
        idleTimeoutMs: 0,
        spawnProcess: this.spawnProcess,
        terminateProcessGroup: this.terminateProcessGroup,
        ...defined({
          continueSession: workerOptions.continuation,
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
    const initial = this.operations.run(async () => {
      await this.loadState();
      for (const [id, task] of this.taskState) {
        if (task.status !== "queued" && task.status !== "running") continue;
        this.taskState.set(id, { ...task, status: "aborted", updated_at: this.nowIso() });
      }
      await this.saveState();
    });
    this.startInFlight = initial;
    try {
      await initial;
    } finally {
      if (this.startInFlight === initial) this.startInFlight = undefined;
    }
    if (!this.running) return;
    this.timer = this.schedule(() => this.emitHeartbeat(), this.heartbeatIntervalMs) as NodeJS.Timeout;
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    await Promise.all(this.inFlight.map((entry) => entry.worker.stop().catch((error) => this.report(error))));
    for (;;) {
      const pending: Promise<unknown>[] = [];
      if (this.startInFlight) pending.push(this.startInFlight);
      for (const settle of [...this.pendingSettles]) pending.push(settle.catch(() => {}));
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  async spawn(params: Record<string, unknown>, owner: ConversationAgentRef, runId: string = randomUUID()): Promise<SpawnResult> {
    const input = validateLaunchInput(params);
    return this.operations.run(async () => {
      await this.loadState();
      if (this.taskState.has(runId)) throw new Error(`Task ${runId} already exists`);
      const status = this.runningCount() < MAX_CONCURRENT_TASKS ? "running" : "queued";
      this.taskState.set(runId, { id: runId, owner: taskOwner(owner), status, updated_at: this.nowIso() });
      await this.saveState();
      await this.timeline.publish({ type: "task_started", runId, owner, ...input });
      const queued = { runId, owner, continuation: false, ...input };
      if (status === "queued") this.queued.push(queued);
      else await this.claimAndLaunch(queued);
      return { runId, status: status === "queued" ? "queued" : "launched" };
    });
  }

  async continueTask(params: Record<string, unknown>, actor: ConversationAgentRef): Promise<SpawnResult> {
    const runId = this.validateRunId(params.runId);
    const input = validateLaunchInput(params);
    return this.operations.run(async () => {
      await this.loadState();
      const task = this.ownedTask(runId, actor);
      if (!isTerminal(task.status)) throw new Error(`Task ${runId} is still ${task.status}; use steer_task while it is running`);
      await this.prepareRunDirectory(runId, true);
      const status = this.runningCount() < MAX_CONCURRENT_TASKS ? "running" : "queued";
      this.taskState.set(runId, { ...task, status, updated_at: this.nowIso() });
      await this.saveState();
      await this.timeline.publish({ type: "task_continued", runId, owner: actor, ...input });
      const queued = { runId, owner: actor, continuation: true, ...input };
      if (status === "queued") this.queued.push(queued);
      else await this.claimAndLaunch(queued);
      return { runId, status: status === "queued" ? "queued" : "launched" };
    });
  }

  async cancel(runId: string, actor: ConversationAgentRef): Promise<"stopped" | "cancelled-queued" | "not-running"> {
    return this.operations.run(async () => {
      await this.loadState();
      const task = this.taskState.get(runId);
      if (!task) return "not-running";
      this.assertOwner(task, actor);
      const entry = this.inFlight.find((item) => item.runId === runId);
      if (entry !== undefined) {
        entry.cancelled = true;
        await entry.worker.stop();
        return "stopped";
      }
      const queuedIndex = this.queued.findIndex((item) => item.runId === runId);
      if (queuedIndex >= 0) {
        this.queued.splice(queuedIndex, 1);
        this.taskState.set(runId, { ...task, status: "aborted", updated_at: this.nowIso() });
        await this.saveState();
        return "cancelled-queued";
      }
      return "not-running";
    });
  }

  async steer(runId: string, message: string, actor: ConversationAgentRef): Promise<"delivered" | "not-running"> {
    return this.operations.run(async () => {
      await this.loadState();
      const task = this.taskState.get(runId);
      if (!task) return "not-running";
      this.assertOwner(task, actor);
      const entry = this.inFlight.find((item) => item.runId === runId);
      if (entry === undefined) return "not-running";
      if (entry.status === "starting") {
        entry.pendingSteers.push(message);
        return "delivered";
      }
      await entry.worker.steer(message);
      return "delivered";
    });
  }

  private async claimAndLaunch(task: QueuedTask): Promise<void> {
    const runDirectory = await this.prepareRunDirectory(task.runId, task.continuation);
    const token = this.credentials.issue({ kind: "task", runId: task.runId }, ["annotate"]);
    const run: TaskRun = { ...task, token };
    let worker: WorkspaceTaskWorker;
    try {
      worker = await this.workerFactory({ workspace: this.workspace, runId: task.runId, prompt: task.prompt, token, continuation: task.continuation, ...defined({ model: task.model, thinking: task.thinking }) });
    } catch (error) {
      this.credentials.revoke(token);
      await this.settleTask(run, runDirectory, { code: null, signal: null, stderr: errorMessage(error), stdout: "" });
      await this.launchNext();
      return;
    }
    this.launchTask(run, runDirectory, worker);
  }

  private launchTask(task: TaskRun, runDirectory: string, worker: WorkspaceTaskWorker): void {
    const entry: InFlightTask = {
      worker,
      runId: task.runId,
      owner: task.owner,
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
    const settle = this.runAndSettle(task, runDirectory, worker);
    this.pendingSettles.add(settle);
    void settle.catch((error) => this.report(error)).finally(() => this.pendingSettles.delete(settle));
  }

  private async runAndSettle(task: TaskRun, runDirectory: string, worker: WorkspaceTaskWorker): Promise<void> {
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
    await this.operations.run(async () => {
      await this.settleTask(task, runDirectory, result);
      if (this.running) await this.launchNext();
    });
  }

  private async settleTask(task: TaskRun, runDirectory: string, result: PiRunResult): Promise<void> {
    const status: "done" | "failed" | "aborted" = result.signal !== null ? "aborted" : result.code === 0 ? "done" : "failed";
    const stderr = status === "failed" ? errorMessage(result.stderr) : undefined;
    if (status === "done") await writeTaskOutput(runDirectory, result.stdout);
    else await rm(path.join(runDirectory, OUTPUT_FILE), { force: true });
    const state = this.taskState.get(task.runId);
    if (state) {
      this.taskState.set(task.runId, { ...state, status, updated_at: this.nowIso() });
      await this.saveState();
    }
    await this.timeline.publish({
      type: "task_finished",
      runId: task.runId,
      owner: task.owner,
      prompt: task.prompt,
      status,
      exitCode: result.code,
      ...defined({ stderr }),
    });
  }

  private async launchNext(): Promise<void> {
    const next = this.queued.shift();
    if (!next) return;
    const state = this.taskState.get(next.runId);
    if (!state) return;
    this.taskState.set(next.runId, { ...state, status: "running", updated_at: this.nowIso() });
    await this.saveState();
    await this.claimAndLaunch(next);
  }

  private async prepareRunDirectory(runId: string, continuation: boolean): Promise<string> {
    const tasksPath = path.join(this.workspace, TASKS_DIR);
    await ensureRealDirectory(tasksPath, "Tasks path");
    const runDirectory = path.join(tasksPath, runId);
    if (continuation) {
      const entry = await lstat(runDirectory).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
      if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error(`Task ${runId} has no resumable session`);
      const sessions = await lstat(path.join(runDirectory, SESSIONS_DIR)).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
      if (!sessions?.isDirectory() || sessions.isSymbolicLink()) throw new Error(`Task ${runId} has no resumable session`);
    } else {
      await ensureRealDirectory(runDirectory, `Task ${runId} path`);
      await ensureRealDirectory(path.join(runDirectory, SESSIONS_DIR), `Task ${runId} sessions`);
    }
    await Promise.all([
      rm(path.join(runDirectory, OUTPUT_FILE), { force: true }),
      rm(path.join(runDirectory, LEGACY_PROMPT_FILE), { force: true }),
      rm(path.join(runDirectory, LEGACY_RESULT_FILE), { force: true }),
    ]);
    return runDirectory;
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.statePath, READ_FILE);
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.stateLoaded = true;
      return;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_TASK_STATE_BYTES) throw new Error("Invalid tasks state file");
      const raw = (await readFileBounded(handle, MAX_TASK_STATE_BYTES)).toString("utf8");
      const file = validateTaskStateFile(JSON.parse(raw) as unknown);
      this.taskState.clear();
      for (const task of file.tasks) this.taskState.set(task.id, task);
      this.pruneState();
      this.stateLoaded = true;
    } finally {
      await closeQuietly(handle);
    }
  }


  private async saveState(): Promise<void> {
    this.pruneState();
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify({ version: 1, tasks: [...this.taskState.values()] } satisfies TaskStateFile, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_TASK_STATE_BYTES) throw new Error(`Tasks state exceeds ${MAX_TASK_STATE_BYTES} bytes`);
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.statePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private pruneState(): void {
    const cutoff = this.now() - TASK_RETENTION_MS;
    for (const [id, task] of this.taskState) {
      if (isTerminal(task.status) && Date.parse(task.updated_at) < cutoff) this.taskState.delete(id);
    }
  }

  private ownedTask(runId: string, actor: ConversationAgentRef): TaskState {
    const task = this.taskState.get(runId);
    if (!task) throw new Error(`Task ${runId} is no longer tracked`);
    this.assertOwner(task, actor);
    return task;
  }

  private assertOwner(task: TaskState, actor: ConversationAgentRef): void {
    if (!sameConversation(ownerRef(task.owner), actor)) throw new Error(`Task ${task.id} is not owned by this conversation`);
  }

  private validateRunId(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) throw new Error("runId must be a non-empty string");
    return value;
  }

  private runningCount(): number {
    let count = 0;
    for (const task of this.taskState.values()) if (task.status === "running") count += 1;
    return count;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private emitHeartbeat(): void {
    const now = this.now();
    const groups = new Map<string, { owner: ConversationAgentRef; tasks: InFlightTask[] }>();
    for (const task of this.inFlight) {
      const { chatId, threadId } = task.owner;
      const key = `${chatId}:${threadId}`;
      const group = groups.get(key) ?? { owner: task.owner, tasks: [] };
      group.tasks.push(task);
      groups.set(key, group);
    }
    for (const { owner, tasks: running } of groups.values()) {
      const tasks = running.map((task) => {
        const { at, text } = task.worker.activity();
        const runningMs = Math.max(0, now - task.startedAt);
        const idleMs = at > 0 ? Math.max(0, now - at) : null;
        return { runId: task.runId, prompt: task.prompt, runningMs, idleMs, ...(text.length > 0 ? { lastOutput: text } : {}) };
      });
      this.timeline.notify({ type: "task_progress", owner, tasks });
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
