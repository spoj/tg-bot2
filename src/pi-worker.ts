import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
  busyTimeoutMs?: number;
  busyTimeoutMessage?: string;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_BUSY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const BUSY_WATCHDOG_CHECK_INTERVAL_MS = 15_000; // 15 seconds
const DEFAULT_STOP_GRACE_MS = 1_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_SIGNAL_TIMEOUT_MS = 2_147_483_647;
const MAX_ACTIVITY_TEXT = 240;

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
    ".tg-bot",
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
  private readonly busyTimeoutMs: number;
  private readonly busyTimeoutMessage: string | undefined;
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
  private busyTimer: NodeJS.Timeout | undefined;
  private startPromise: Promise<void> | undefined;
  private exitPromise: Promise<PiRunResult> | undefined;
  private readonly settledResolvers = new Set<(result: PiRunResult) => void>();
  private reapedCallback: (() => void) | undefined;
  private closing = false;

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
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error("busyTimeoutMs must be a non-negative integer");
    }
    this.busyTimeoutMs = busyTimeoutMs;
    this.busyTimeoutMessage = options.busyTimeoutMessage;
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
    this.lastActivityAt = Date.now();
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
        resume: this.options.resume,
        sessionDir: this.options.sessionDir,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        hostTools: this.options.hostTools,
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
      child.stdout?.on("data", (chunk: Buffer | string) => {
        this.noteActivity(chunk);
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.stdout = boundedCapture(this.stdout, text);
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          this.handleStdoutLine(trimmed);
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.noteActivity(chunk);
        this.stderr = boundedCapture(this.stderr, chunk);
      });
      child.once("exit", (code, signal) => {
        if (buffer.trim().length > 0) {
          this.handleStdoutLine(buffer.trim());
        }
        this.clearIdleTimer();
        this.clearBusyWatchdog();
        this.isBusyState = false;
        this.process = undefined;
        const result: PiRunResult = { code, signal, stderr: this.stderr, stdout: this.stdout };
        this.resolveSettled(result);
        resolve(result);
      });
    });

    // Configure steering mode and follow-up mode to "all" on RPC startup
    this.writeJson({ id: "init-steer", type: "set_steering_mode", mode: "all" });
    this.writeJson({ id: "init-followup", type: "set_follow_up_mode", mode: "all" });

    this.armIdleTimer();
  }

  private handleStdoutLine(line: string): void {
    try {
      const event = JSON.parse(line) as { type?: string };
      if (event.type === "agent_start" || event.type === "turn_start") {
        this.isBusyState = true;
        this.clearIdleTimer();
        this.armBusyWatchdog();
      } else if (event.type === "agent_settled") {
        this.isBusyState = false;
        this.clearBusyWatchdog();
        this.armIdleTimer();
        this.resolveSettled({ code: 0, signal: null, stderr: this.stderr, stdout: this.stdout });
      }
    } catch {
      // Non-JSON stdout lines are activity only
    }
  }

  private resolveSettled(result: PiRunResult): void {
    const resolvers = [...this.settledResolvers];
    this.settledResolvers.clear();
    for (const resolve of resolvers) {
      resolve(result);
    }
  }

  private writeJson(obj: unknown): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    try {
      stdin.write(JSON.stringify(obj) + "\n", "utf8");
    } catch {
      // Write failure on closing stream
    }
  }

  abort(): void {
    this.writeJson({ id: randomUUID(), type: "abort" });
  }

  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    if (!this.isAlive()) {
      await this.start();
    }
    this.isBusyState = true;
    this.clearIdleTimer();
    this.armBusyWatchdog();
    this.noteActivity(message);
    this.writeJson({
      id: randomUUID(),
      type: "prompt",
      message,
      ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
    });
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
    this.clearIdleTimer();
    this.clearBusyWatchdog();
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
    this.clearIdleTimer();
    this.clearBusyWatchdog();
    const child = this.process;
    if (!child || !this.isAlive()) return Promise.resolve();

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

  private armBusyWatchdog(): void {
    if (this.busyTimeoutMs <= 0 || !Number.isFinite(this.busyTimeoutMs)) return;
    this.clearBusyWatchdog();
    const interval = Math.min(BUSY_WATCHDOG_CHECK_INTERVAL_MS, Math.max(100, Math.floor(this.busyTimeoutMs / 2)));
    this.busyTimer = this.setIntervalFn(() => {
      void this.checkBusyTimeout();
    }, interval);
    this.busyTimer.unref?.();
  }

  private clearBusyWatchdog(): void {
    if (this.busyTimer !== undefined) {
      this.clearIntervalFn(this.busyTimer);
      this.busyTimer = undefined;
    }
  }

  private checkBusyTimeout(): void {
    if (!this.isBusyState || !this.isAlive()) {
      this.clearBusyWatchdog();
      return;
    }
    const elapsed = Date.now() - this.lastActivityAt;
    if (elapsed >= this.busyTimeoutMs) {
      this.handleBusyTimeout();
    }
  }

  private handleBusyTimeout(): void {
    this.abort();
    this.lastActivityAt = Date.now();
    const message = this.busyTimeoutMessage ?? "Interrupted: Operation took too long with no progress.";
    this.noteActivity(message);
    this.writeJson({
      id: randomUUID(),
      type: "prompt",
      message,
      streamingBehavior: "steer",
    });
  }
}
