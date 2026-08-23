import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  buildPiRunBwrapArgs,
  type PiRunSandboxPaths,
  type PiWorkerChildProcess,
  type PiWorkerSpawn,
} from "./sandbox.js";
import { defined } from "./util.js";

export type PiRunResult = {
  /** Exit code when the process ran to completion; null when signal-killed. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

export type PiWorkerOptions = PiRunSandboxPaths & {
  bwrapPath?: string;
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  /** Invoked once, after the first prompt JSON-RPC write (the worker's initial prompt). */
  onInitialPromptWritten?: () => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours of idle: settled and waiting for a prompt. Busy turns are not bounded by this (the idle timer is disarmed until the agent settles), so workers — and any subprocesses they keep — die only after being idle this long.
const DEFAULT_STOP_GRACE_MS = 1_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_SIGNAL_TIMEOUT_MS = 2_147_483_647;
const MAX_ACTIVITY_TEXT = 240;
const STEER_CONTINUATION = "Continue from the latest user instruction without repeating completed work.";

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function boundedCapture(previous: string, chunk: string | Buffer): string {
  const incoming = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const available = MAX_CAPTURE_BYTES - 1 - incoming.length;
  if (available <= 0) return `…${incoming.slice(-(MAX_CAPTURE_BYTES - 1))}`;
  if (previous.length > available) return `…${previous.slice(-available)}${incoming}`;
  return previous + incoming;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Pi run runtime path must be a real directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

async function ensureWebSearchConfig(workspace: string): Promise<void> {
  const configPath = path.join(workspace, ".pi", "agent", "web-search.json");
  try {
    await writeFile(configPath, '{"workflow":"none","autoOpenBrowser":false}\n', {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function ensurePromptFile(appRoot: string, content: string): Promise<string> {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const promptDir = path.join(appRoot, ".prompts");
  await ensurePrivateDirectory(promptDir);
  const promptFile = path.join(promptDir, `prompt-${hash}.md`);
  try {
    await writeFile(promptFile, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return promptFile;
}

async function prepareWorkspace(workspace: string): Promise<void> {
  await ensurePrivateDirectory(workspace);
  for (const relative of [
    ".pi",
    ".pi/agent",
    ".pi/sessions",
    ".cache",
    ".cache/npm",
    ".cache/uv",
    ".local",
    ".local/bin",
    ".local/share/uv/tools",
    ".python",
  ]) {
    await ensurePrivateDirectory(path.join(workspace, relative));
  }
  await ensureWebSearchConfig(workspace);
}

/**
 * Pi RPC worker: manages a long-running `pi --mode rpc` process inside bwrap,
 * handling JSON-RPC prompting, mid-flight steering, follow-ups, and idle reaping.
 */
export class PiWorker {
  readonly options: PiWorkerOptions;
  private readonly bwrapPath: string;
  private readonly stopGraceMs: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private process: PiWorkerChildProcess | undefined;
  private stdout = "";
  private stderr = "";
  private lastActivityAt = 0;
  private lastActivity = "";
  private isBusyState = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private steerWaitTimer: NodeJS.Timeout | undefined;
  private steerWaitExpiresAt: number | undefined;
  private startPromise: Promise<void> | undefined;
  private exitPromise: Promise<PiRunResult> | undefined;
  private readonly settledResolvers = new Set<(result: PiRunResult) => void>();
  private reapedCallback: (() => void) | undefined;
  private closing = false;
  private stopped = false;
  private initialPromptWritten = false;

  constructor(options: PiWorkerOptions) {
    this.options = options;
    this.bwrapPath = options.bwrapPath ?? "bwrap";
    const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    if (!Number.isSafeInteger(stopGraceMs) || stopGraceMs < 0) {
      throw new Error("stopGraceMs must be a non-negative integer");
    }
    if (stopGraceMs > MAX_SIGNAL_TIMEOUT_MS) {
      throw new Error(`stopGraceMs must not exceed ${MAX_SIGNAL_TIMEOUT_MS}`);
    }
    this.stopGraceMs = stopGraceMs;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
      throw new Error("idleTimeoutMs must be a non-negative integer");
    }
    this.idleTimeoutMs = idleTimeoutMs;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? clearInterval;
  }
  isAlive(): boolean {
    return this.process !== undefined && this.process.exitCode === null && this.process.signalCode === null;
  }

  isBusy(): boolean {
    return this.isBusyState;
  }

  activity(): { at: number; text: string } {
    return { at: this.lastActivityAt, text: this.lastActivity };
  }

  onReaped(callback: () => void): void {
    this.reapedCallback = callback;
  }

  private noteActivity(chunk: string | Buffer): void {
    this.lastActivityAt = this.now();
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      this.lastActivity = trimmed.length <= MAX_ACTIVITY_TEXT ? trimmed : `${trimmed.slice(0, MAX_ACTIVITY_TEXT - 1)}…`;
    }
  }

  async start(): Promise<void> {
    if (this.isAlive()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    this.stdout = "";
    this.stderr = "";
    this.lastActivityAt = 0;
    this.lastActivity = "";
    this.isBusyState = false;
    this.closing = false;

    await prepareWorkspace(this.options.workspace);
    const promptFile = this.options.appendSystemPrompt !== undefined
      ? await ensurePromptFile(this.options.appRoot, this.options.appendSystemPrompt)
      : undefined;
    const built = await buildPiRunBwrapArgs({
      workspace: this.options.workspace,
      appRoot: this.options.appRoot,
      ...defined({
        cliPath: this.options.cliPath,
        appendSystemPrompt: promptFile,
        sessionDir: this.options.sessionDir,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        hostTools: this.options.hostTools,
        agentToken: this.options.agentToken,
        hostSocketDir: this.options.hostSocketDir,
        hostTimeline: this.options.hostTimeline,
        hostAttachments: this.options.hostAttachments,
        taskRun: this.options.taskRun,
      }),
    });

    let child: PiWorkerChildProcess;
    try {
      child = this.options.spawnProcess(this.bwrapPath, built.args, {
        detached: true,
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`Pi run spawn failed: ${asError(error).message}`);
    }
    this.process = child;

    this.exitPromise = new Promise<PiRunResult>((resolve) => {
      let buffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const consumeStdout = (text: string): void => {
        if (text.length === 0) return;
        this.stdout = boundedCapture(this.stdout, text);
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          this.handleStdoutLine(trimmed);
        }
      };
      const consumeStderr = (text: string): void => {
        if (text.length === 0) return;
        this.noteActivity(text);
        this.stderr = boundedCapture(this.stderr, text);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => {
        consumeStdout(typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        consumeStderr(typeof chunk === "string" ? chunk : stderrDecoder.write(chunk));
      });
      child.once("error", (error) => consumeStderr(asError(error).message));
      child.once("close", (code, signal) => {
        consumeStdout(stdoutDecoder.end());
        consumeStderr(stderrDecoder.end());
        if (buffer.trim().length > 0) {
          this.handleStdoutLine(buffer.trim());
        }
        this.clearIdleTimer();
        this.clearSteerWaitTimer();
        this.isBusyState = false;
        this.process = undefined;
        const result: PiRunResult = { code, signal, stderr: this.stderr, stdout: this.stdout };
        this.resolveSettled(result);
        resolve(result);
      });
    });

    if (this.stopped) {
      // stop() arrived before the spawn finished; never let this run go on.
      await this.terminateProcess(child);
      return;
    }

    this.writeJson({ id: "init-steer", type: "set_steering_mode", mode: "all" });
    this.writeJson({ id: "init-followup", type: "set_follow_up_mode", mode: "all" });

    this.armIdleTimer();
  }

  private handleStdoutLine(line: string): void {
    try {
      const event = JSON.parse(line) as { id?: unknown; type?: unknown; success?: unknown; error?: unknown; steering?: unknown };
      if (event.type === "response") return;
      if (event.type === "queue_update" && Array.isArray(event.steering) && event.steering.length === 0) {
        this.clearSteerWaitTimer();
      }
      this.noteActivity(line);
      if (event.type === "agent_start" || event.type === "turn_start") {
        this.isBusyState = true;
        this.clearIdleTimer();
      } else if (event.type === "agent_settled") {
        this.isBusyState = false;
        this.clearSteerWaitTimer();
        this.armIdleTimer();
        this.resolveSettled({ code: 0, signal: null, stderr: this.stderr, stdout: this.stdout });
      }
    } catch {
      this.noteActivity(line);
    }
  }

  private resolveSettled(result: PiRunResult): void {
    const resolvers = [...this.settledResolvers];
    this.settledResolvers.clear();
    for (const resolve of resolvers) {
      resolve(result);
    }
  }

  private writeJson(obj: unknown): boolean {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(JSON.stringify(obj) + "\n", "utf8");
      return true;
    } catch {
      // Write failure on closing stream
      return false;
    }
  }



  async prompt(message: string, streamingBehavior?: "steer" | "followUp", maxWaitMs?: number): Promise<void> {
    if (!this.isAlive()) {
      if (this.stopped) return;
      await this.start();
    }
    const queued = this.isBusyState && streamingBehavior === "steer";
    this.isBusyState = true;
    this.clearIdleTimer();
    this.noteActivity(message);
    const wrote = this.writeJson({
      id: randomUUID(),
      type: "prompt",
      message,
      ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
    });
    if (wrote && queued && maxWaitMs !== undefined) this.armSteerWaitTimer(maxWaitMs);
    if (wrote && !this.initialPromptWritten) {
      this.initialPromptWritten = true;
      this.options.onInitialPromptWritten?.();
    }
  }

  private armSteerWaitTimer(maxWaitMs: number): void {
    const expiresAt = this.now() + maxWaitMs;
    if (this.steerWaitExpiresAt !== undefined && this.steerWaitExpiresAt <= expiresAt) return;
    this.clearSteerWaitTimer();
    const child = this.process;
    this.steerWaitExpiresAt = expiresAt;
    this.steerWaitTimer = this.setTimeoutFn(() => {
      this.steerWaitTimer = undefined;
      this.steerWaitExpiresAt = undefined;
      if (this.process !== child || !this.isBusyState || !this.isAlive()) return;
      this.writeJson({ id: randomUUID(), type: "abort" });
      this.writeJson({ id: randomUUID(), type: "prompt", message: STEER_CONTINUATION, streamingBehavior: "steer" });
    }, maxWaitMs);
    this.steerWaitTimer.unref?.();
  }

  private clearSteerWaitTimer(): void {
    if (this.steerWaitTimer !== undefined) this.clearTimeoutFn(this.steerWaitTimer);
    this.steerWaitTimer = undefined;
    this.steerWaitExpiresAt = undefined;
  }

  waitForSettled(): Promise<PiRunResult> {
    if (!this.isAlive()) {
      return this.exitPromise ?? Promise.resolve({ code: 0, signal: null, stderr: this.stderr, stdout: this.stdout });
    }
    if (!this.isBusyState) {
      return Promise.resolve({ code: 0, signal: null, stderr: this.stderr, stdout: this.stdout });
    }
    return new Promise<PiRunResult>((resolve) => {
      this.settledResolvers.add(resolve);
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.exitPromise ? this.exitPromise.then(() => {}) : Promise.resolve();
    this.closing = true;
    this.clearSteerWaitTimer();
    this.clearIdleTimer();
    const child = this.process;
    if (!child || !this.isAlive()) return Promise.resolve();

    const done = this.exitPromise ?? Promise.resolve({ code: null, signal: null, stderr: "", stdout: "" });
    try {
      child.stdin?.end();
    } catch {
      this.options.terminateProcessGroup(child, "SIGTERM");
    }

    const timer = this.setTimeoutFn(() => {
      if (this.isAlive()) {
        this.options.terminateProcessGroup(child, "SIGKILL");
      }
    }, this.stopGraceMs);
    timer.unref?.();

    await done.finally(() => this.clearTimeoutFn(timer));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearSteerWaitTimer();
    this.clearIdleTimer();
    let child = this.process;
    if (!child) {
      // Stop arriving while the run is still starting: wait for the spawn, then
      // terminate it here (otherwise the running prompt would take the task
      // to completion instead of settling it aborted).
      await this.startPromise?.catch(() => {});
      child = this.process;
    }
    if (!child || !this.isAlive()) return Promise.resolve();
    await this.terminateProcess(child);
  }

  /** SIGTERM the process group, escalate to SIGKILL after stopGraceMs, and wait for exit. */
  private async terminateProcess(child: PiWorkerChildProcess): Promise<void> {
    const done = this.exitPromise ?? Promise.resolve({ code: null, signal: null, stderr: "", stdout: "" });
    this.options.terminateProcessGroup(child, "SIGTERM");

    const timer = this.setTimeoutFn(() => {
      if (this.isAlive()) {
        this.options.terminateProcessGroup(child, "SIGKILL");
      }
    }, this.stopGraceMs);
    timer.unref?.();

    await done.finally(() => this.clearTimeoutFn(timer));
  }

  private armIdleTimer(): void {
    if (this.idleTimeoutMs <= 0 || !Number.isFinite(this.idleTimeoutMs)) return;
    this.clearIdleTimer();
    this.idleTimer = this.setTimeoutFn(() => {
      void this.onIdleTimeout();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      this.clearTimeoutFn(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private async onIdleTimeout(): Promise<void> {
    if (this.isBusyState || !this.isAlive()) return;
    await this.close();
    this.reapedCallback?.();
  }

}
