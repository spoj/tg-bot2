import { constants as fsConstants, watch } from "node:fs";
import type { FSWatcher, Stats } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendChatEvent } from "./events.js";
import { PiRunWorker, type PiRunResult } from "./pi-worker.js";
import { SerialQueue } from "./queue.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { SUBAGENT_PROMPT } from "./task-protocol.js";
import { chatPaths, defined, errorCode, numericChatId, openPinnedDirectory, TG_BOT_DIR, type PinnedDirectory } from "./util.js";

export type WorkspaceTaskWorker = {
  run(): Promise<PiRunResult>;
  stop(): Promise<void>;
};

export type WorkspaceTaskWorkerOptions = {
  workspace: string;
  taskId: string;
  /** The complete prompt read from the claimed task file. */
  prompt: string;
};

export type WorkspaceTaskWorkerFactory = (options: WorkspaceTaskWorkerOptions) => WorkspaceTaskWorker | Promise<WorkspaceTaskWorker>;

export type WorkspaceTasksOptions = {
  dataDir: string;
  appRoot: string;
  bwrapPath?: string;
  /** Process-control seams injected by the composition root; the default worker factory passes them to the Pi run worker. */
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  workerFactory?: WorkspaceTaskWorkerFactory;
  /** Wakes the agent after each task settles; the completion is recorded in events.jsonl first. */
  wakeAgent?: (chatId: number) => Promise<void> | void;
  pollIntervalMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  watch?: typeof watch;
  logger?: (error: unknown) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 50;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_DIAGNOSTIC_LENGTH = 1_024;
const MAX_TASK_BYTES = 64 * 1024;
// Bound attacker-controlled directory work while preserving lexical ordering of the captured entries.
const MAX_CHAT_DIRECTORIES_PER_POLL = 256;
const MAX_TASK_ENTRIES_PER_CHAT = 256;
const MAX_SUBAGENT_DIRS_PER_CHAT = 16;
const MAX_SUBAGENT_DIRS_PER_SCAN = 2 * MAX_SUBAGENT_DIRS_PER_CHAT;
const TASK_DIR = "task";
const SUBAGENTS_DIR = path.join(".pi", "subagents");
const SESSIONS_DIR = "sessions";
const TASK_FILE_NAME = "task.md";
const OUTPUT_FILE = "output.md";
const RESULT_FILE = "result.json";
const TASK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(txt|md)$/u;
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const NON_BLOCKING = fsConstants.O_NONBLOCK;

type ChatWatcher = {
  watcher: FSWatcher;
  debounce: NodeJS.Timeout | undefined;
};

type InFlightTask = {
  taskId: string;
  worker: WorkspaceTaskWorker;
};

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorMessage(error: unknown): string {
  let detail: string;
  try {
    detail = error instanceof Error ? error.message : String(error);
  } catch {
    detail = "unknown error";
  }
  return detail.length > MAX_DIAGNOSTIC_LENGTH ? `${detail.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : detail;
}

async function readBoundedEntries(directory: string, limit: number) {
  const directoryHandle = await opendir(directory);
  const entries = [];
  try {
    for (;;) {
      const entry = await directoryHandle.read();
      if (entry === null) break;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
  } finally {
    await directoryHandle.close().catch(() => {});
  }
  return entries;
}

/** Reads a claimed task file without following symlinks; rejects empty or oversized prompts. */
async function readTaskPrompt(filePath: string): Promise<string> {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Task file is not a regular file");
    if (stat.size > MAX_TASK_BYTES) throw new Error(`Task file exceeds ${MAX_TASK_BYTES} bytes`);
    const buffer = Buffer.allocUnsafe(MAX_TASK_BYTES);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      bytesRead += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    const prompt = buffer.subarray(0, bytesRead).toString("utf8");
    if (prompt.trim().length === 0) throw new Error("Task prompt must not be empty");
    return prompt;
  } finally {
    await handle.close();
  }
}

/** Removes a host-owned run directory without following symlinks planted inside it. */
async function removeTree(directory: string, depth: number): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeTree(child, depth - 1);
    else await unlink(child);
  }
  await rmdir(directory);
}

/** Ensures the subagents root is a real directory, replacing a planted symlink. */
async function ensureSubagentsDirectory(workspace: string): Promise<string> {
  const directory = path.join(workspace, SUBAGENTS_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Subagents path must be a real directory: ${directory}`);
  }
  return directory;
}

async function newestSessionFile(sessionsDirectory: string): Promise<string | undefined> {
  let newest: { name: string; mtimeMs: number } | undefined;
  try {
    const entries = await readdir(sessionsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
      const stat = await lstat(path.join(sessionsDirectory, entry.name));
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { name: entry.name, mtimeMs: stat.mtimeMs };
    }
  } catch {
    return undefined;
  }
  return newest?.name;
}

/**
 * Runs agent-submitted subagent tasks: watches .tg-bot/task/*.txt|md, claims each
 * file by moving it into a per-task run directory, executes one background Pi run
 * per chat at a time, and reports completions as events plus an agent wake.
 */
export class WorkspaceTasks {
  private readonly wakeAgent: WorkspaceTasksOptions["wakeAgent"];
  private readonly dataDir: string;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  private readonly stopGraceMs: number | undefined;
  private readonly workerFactory: WorkspaceTaskWorkerFactory;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly watchFs: typeof watch;
  private readonly logger: (error: unknown) => void;
  private readonly queues = new Map<number, SerialQueue>();
  private readonly chatWatchers = new Map<number, ChatWatcher>();
  private readonly inFlight = new Map<number, InFlightTask>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceTasksOptions) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_TIMER_MS) {
      throw new Error("Task poll interval must be a positive timer-safe integer");
    }
    this.dataDir = path.resolve(options.dataDir);
    this.appRoot = path.resolve(options.appRoot);
    this.bwrapPath = options.bwrapPath;
    this.spawnProcess = options.spawnProcess;
    this.terminateProcessGroup = options.terminateProcessGroup;
    this.stopGraceMs = options.stopGraceMs;
    this.wakeAgent = options.wakeAgent;
    this.pollIntervalMs = pollIntervalMs;
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Workspace task error", error));
    this.watchFs = options.watch ?? watch;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiRunWorker({
      workspace: workerOptions.workspace,
      appRoot: this.appRoot,
      ...defined({ bwrapPath: this.bwrapPath }),
      appendSystemPrompt: SUBAGENT_PROMPT,
      message: workerOptions.prompt,
      resume: false,
      sessionDir: `/workspace/.pi/subagents/${workerOptions.taskId}/${SESSIONS_DIR}`,
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
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.closeWatchers();
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    const stops = [...this.inFlight.values()].map(({ worker }) => worker.stop().catch((error) => this.report(error)));
    await Promise.all(stops);
    for (;;) {
      const pending: Promise<void>[] = [];
      if (this.startInFlight) pending.push(this.startInFlight);
      if (this.pollInFlight) pending.push(this.pollInFlight);
      let queued = 0;
      for (const queue of this.queues.values()) queued += queue.size;
      if (queued > 0) pending.push((async (): Promise<void> => {
        for (;;) {
          const live = [...this.queues.values()];
          if (live.length === 0) return;
          await Promise.all(live.map((queue) => queue.idle()));
          await Promise.resolve();
        }
      })());
      if (pending.length === 0) return;
      await Promise.all(pending.map((operation) => operation.catch(() => {})));
    }
  }

  /** Poll numeric chat workspaces; concurrent calls share one operation. */
  async poll(): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    const operation = this.runPoll();
    this.pollInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.pollInFlight === operation) this.pollInFlight = undefined;
    }
  }

  /** Process one numeric chat workspace; same-chat calls are serialized. */
  async processChat(chatId: number, chatsRoot?: PinnedDirectory): Promise<void> {
    if (!Number.isSafeInteger(chatId)) throw new Error("Task chat ID must be a safe integer");
    const workspace = chatPaths(this.dataDir, chatId).workspace;
    await this.enqueueChatScan(chatId, workspace, chatsRoot);
  }

  private enqueueChatScan(chatId: number, workspace: string, chatsRoot?: PinnedDirectory): Promise<void> {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = new SerialQueue();
      this.queues.set(chatId, queue);
    }
    return queue.run(() => this.processChatNow(chatId, workspace, chatsRoot)).finally(() => {
      if (queue.size === 0 && this.queues.get(chatId) === queue) {
        this.queues.delete(chatId);
      }
    });
  }

  /** Watch one chat's task directory, scheduling a debounced scan on filesystem events. */
  private async ensureWatcher(chatId: number, workspace: string): Promise<void> {
    if (!this.running || this.chatWatchers.has(chatId)) return;
    const taskDirectory = path.join(workspace, TG_BOT_DIR, TASK_DIR);
    let stat: Stats;
    try {
      stat = await lstat(taskDirectory);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
      return;
    }
    if (!this.running) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    let watcher: FSWatcher;
    try {
      watcher = this.watchFs(taskDirectory);
    } catch (error) {
      this.report(error);
      return;
    }
    const entry: ChatWatcher = { watcher, debounce: undefined };
    this.chatWatchers.set(chatId, entry);
    watcher.on("change", () => this.debounceChatScan(chatId, workspace));
    watcher.on("rename", () => this.debounceChatScan(chatId, workspace));
    const disarm = (): void => {
      if (this.chatWatchers.get(chatId) !== entry) return;
      clearTimeout(entry.debounce);
      entry.debounce = undefined;
      this.chatWatchers.delete(chatId);
    };
    watcher.on("error", disarm);
    watcher.on("close", disarm);
  }

  private debounceChatScan(chatId: number, workspace: string): void {
    const entry = this.chatWatchers.get(chatId);
    if (!entry) return;
    clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      if (this.chatWatchers.get(chatId) !== entry) return;
      entry.debounce = undefined;
      void this.enqueueChatScan(chatId, workspace).catch((error) => this.report(error));
    }, WATCH_DEBOUNCE_MS);
    entry.debounce.unref();
  }

  private closeWatchers(): void {
    for (const entry of this.chatWatchers.values()) {
      clearTimeout(entry.debounce);
      entry.debounce = undefined;
      try {
        entry.watcher.close();
      } catch {
        // Watcher teardown must never interrupt shutdown.
      }
    }
    this.chatWatchers.clear();
  }

  private async runPoll(): Promise<void> {
    let chatsRoot: PinnedDirectory | undefined;
    try {
      chatsRoot = await openPinnedDirectory(path.join(this.dataDir, "chats"));
      const entries = await readBoundedEntries(chatsRoot.path, MAX_CHAT_DIRECTORIES_PER_POLL);
      const chats = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => ({ chatId: numericChatId(entry.name), name: entry.name }))
        .filter((entry): entry is { chatId: number; name: string } => entry.chatId !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const { chatId } of chats) {
        const workspace = chatPaths(this.dataDir, chatId).workspace;
        if (this.running) await this.ensureWatcher(chatId, workspace);
        try {
          await this.processChat(chatId, chatsRoot);
        } catch (error) {
          this.report(error);
        }
      }
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    } finally {
      if (chatsRoot) await this.closeDirectory(chatsRoot);
    }
  }

  private async processChatNow(chatId: number, workspace: string, chatsRoot?: PinnedDirectory): Promise<void> {
    if (this.inFlight.has(chatId)) return;
    let openedChatsRoot: PinnedDirectory | undefined;
    let chatDirectory: PinnedDirectory | undefined;
    let workspaceDirectory: PinnedDirectory | undefined;
    let metadata: PinnedDirectory | undefined;
    let taskDirectory: PinnedDirectory | undefined;
    try {
      openedChatsRoot = chatsRoot ?? await openPinnedDirectory(path.join(this.dataDir, "chats"));
      chatDirectory = await openPinnedDirectory(path.join(openedChatsRoot.path, String(chatId)));
      workspaceDirectory = await openPinnedDirectory(path.join(chatDirectory.path, "workspace"));
      if (workspaceDirectory.realPath !== path.join(chatDirectory.realPath, "workspace")) {
        throw new Error(`Workspace for chat ${chatId} is outside the chat directory`);
      }
      await this.recoverSubagentDirs(workspace);
      metadata = await openPinnedDirectory(path.join(workspaceDirectory.path, TG_BOT_DIR));
      taskDirectory = await openPinnedDirectory(path.join(metadata.path, TASK_DIR));

      const entries = (await readBoundedEntries(taskDirectory.path, MAX_TASK_ENTRIES_PER_CHAT))
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && TASK_FILE.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      if (entries.length === 0) return;
      const name = entries[0];
      if (name === undefined) return;

      const taskId = name.replace(/\.(txt|md)$/u, "");
      const runDirectory = path.join(workspace, SUBAGENTS_DIR, taskId);
      await removeTree(runDirectory, 2).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await mkdir(path.join(runDirectory, SESSIONS_DIR), { recursive: true, mode: 0o700 });
      try {
        await rename(path.join(taskDirectory.path, name), path.join(runDirectory, TASK_FILE_NAME));
      } catch (error) {
        if (isMissing(error)) return; // The agent deleted the pending task.
        throw error;
      }
      let prompt: string;
      try {
        prompt = await readTaskPrompt(path.join(runDirectory, TASK_FILE_NAME));
      } catch (error) {
        await this.settleTask(chatId, workspace, taskId, runDirectory, {
          code: null,
          signal: null,
          stderr: errorMessage(error),
          stdout: "",
        });
        return;
      }

      let worker: WorkspaceTaskWorker;
      try {
        worker = await this.workerFactory({ workspace, taskId, prompt });
      } catch (error) {
        await this.settleTask(chatId, workspace, taskId, runDirectory, {
          code: null,
          signal: null,
          stderr: errorMessage(error),
          stdout: "",
        });
        return;
      }
      this.inFlight.set(chatId, { taskId, worker });
      let result: PiRunResult;
      try {
        result = await worker.run();
      } catch (error) {
        result = { code: null, signal: null, stderr: errorMessage(error), stdout: "" };
      } finally {
        if (this.inFlight.get(chatId)?.worker === worker) this.inFlight.delete(chatId);
      }
      await this.settleTask(chatId, workspace, taskId, runDirectory, result);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    } finally {
      if (taskDirectory) await this.closeDirectory(taskDirectory);
      if (metadata) await this.closeDirectory(metadata);
      if (workspaceDirectory) await this.closeDirectory(workspaceDirectory);
      if (chatDirectory) await this.closeDirectory(chatDirectory);
      if (chatsRoot === undefined && openedChatsRoot) await this.closeDirectory(openedChatsRoot);
    }
  }

  /** Re-queues run directories orphaned by a host crash and prunes the oldest beyond the cap. */
  private async recoverSubagentDirs(workspace: string): Promise<void> {
    let subagentsPath: string;
    try {
      subagentsPath = await ensureSubagentsDirectory(workspace);
    } catch (error) {
      this.report(error);
      return;
    }
    const entries = await readBoundedEntries(subagentsPath, MAX_SUBAGENT_DIRS_PER_SCAN);
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    const withMtime = await Promise.all(directories.map(async (entry) => ({
      name: entry.name,
      mtimeMs: (await lstat(path.join(subagentsPath, entry.name))).mtimeMs,
    })));
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const directory of withMtime) {
      const runDirectory = path.join(subagentsPath, directory.name);
      try {
        await lstat(path.join(runDirectory, RESULT_FILE));
      } catch (error) {
        if (isMissing(error)) await this.requeueOrphan(workspace, runDirectory, directory.name).catch((requeueError) => this.report(requeueError));
        else this.report(error);
      }
    }
    for (const stale of withMtime.slice(MAX_SUBAGENT_DIRS_PER_CHAT)) {
      await removeTree(path.join(subagentsPath, stale.name), 2).catch((error) => {
        if (!isMissing(error)) this.report(error);
      });
    }
  }

  /** Moves an orphaned task prompt back into the task queue and clears the run directory. */
  private async requeueOrphan(workspace: string, runDirectory: string, taskId: string): Promise<void> {
    const taskDirectory = path.join(workspace, TG_BOT_DIR, TASK_DIR);
    await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
    try {
      await rename(path.join(runDirectory, TASK_FILE_NAME), path.join(taskDirectory, `${taskId}.md`));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await removeTree(runDirectory, 2);
  }

  /** Records the outcome, appends the subagent event, and wakes the agent. */
  private async settleTask(
    chatId: number,
    workspace: string,
    taskId: string,
    runDirectory: string,
    result: PiRunResult,
  ): Promise<void> {
    // A signal-interrupted run (shutdown stop) stays orphaned so the next boot re-queues it.
    if (result.signal !== null) return;
    const failed = result.code !== 0;
    const status = failed ? "failed" : "done";
    const stderr = failed ? errorMessage(result.stderr) : undefined;
    let outputFile: string | undefined;
    if (!failed && result.stdout.trim().length > 0) {
      await writeFile(path.join(runDirectory, OUTPUT_FILE), result.stdout, { encoding: "utf8", mode: 0o600 });
      outputFile = `/workspace/.pi/subagents/${taskId}/${OUTPUT_FILE}`;
    }
    const sessionName = await newestSessionFile(path.join(runDirectory, SESSIONS_DIR));
    const sessionFile = sessionName === undefined ? undefined : `/workspace/.pi/subagents/${taskId}/${SESSIONS_DIR}/${sessionName}`;
    await writeFile(path.join(runDirectory, RESULT_FILE), JSON.stringify({
      status,
      exitCode: result.code,
      signal: result.signal,
      ...defined({ stderr }),
    }), { encoding: "utf8", mode: 0o600 });
    await appendChatEvent(workspace, {
      type: "subagent",
      id: taskId,
      status,
      exitCode: result.code,
      ...defined({ outputFile }),
      ...defined({ sessionFile }),
      ...defined({ stderr }),
    });
    if (this.wakeAgent) {
      void Promise.resolve(this.wakeAgent(chatId)).catch((error) => this.report(error));
    }
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt task processing.
    }
  }

  private async closeDirectory(directory: PinnedDirectory): Promise<void> {
    try {
      await directory.handle.close();
    } catch (error) {
      this.report(error);
    }
  }
}
