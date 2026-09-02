import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  buildPiRunBwrapArgs,
  type PiRunSandboxPaths,
  type PiWorkerChildProcess,
  type PiWorkerSpawn,
} from "./sandbox.js";
import { defined, errorCode } from "./util.js";

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
  /** Invoked once, after the first prompt is accepted by the RPC worker. */
  onInitialPromptWritten?: () => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours of idle: settled and waiting for a prompt. Busy turns are not bounded by this (the idle timer is disarmed until the agent settles), so workers — and any subprocesses they keep — die only after being idle this long.
const DEFAULT_STOP_GRACE_MS = 1_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_SIGNAL_TIMEOUT_MS = 2_147_483_647;
const MAX_ACTIVITY_TEXT = 240;
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

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

function privateDirectoryError(directory: string): Error {
  return new Error(`Pi run runtime path must be a real directory: ${directory}`);
}

/**
 * Walks each path component through a pinned directory handle. O_NOFOLLOW
 * protects every component, while the final handle makes chmod independent of
 * any later rename or symlink replacement at the original path.
 */
async function openPrivateDirectory(directory: string): Promise<Awaited<ReturnType<typeof open>>> {
  const target = path.resolve(directory);
  const root = path.parse(target).root;
  let parent = await open(root, DIRECTORY_OPEN_FLAGS);
  try {
    const relative = path.relative(root, target);
    const components = relative.length === 0 ? [] : relative.split(path.sep);
    for (const component of components) {
      if (component.length === 0 || component === "." || component === "..") throw privateDirectoryError(directory);
      const childPath = `/proc/self/fd/${parent.fd}/${component}`;
      let child: Awaited<ReturnType<typeof open>> | undefined;
      try {
        child = await open(childPath, DIRECTORY_OPEN_FLAGS);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw privateDirectoryError(directory);
        try {
          await mkdir(childPath, { mode: 0o700 });
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== "EEXIST") throw privateDirectoryError(directory);
        }
        try {
          child = await open(childPath, DIRECTORY_OPEN_FLAGS);
        } catch {
          throw privateDirectoryError(directory);
        }
      }
      if (child === undefined) throw privateDirectoryError(directory);
      await parent.close().catch(() => {});
      parent = child;
    }
    return parent;
  } catch (error) {
    await parent.close().catch(() => {});
    throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const handle = await openPrivateDirectory(directory);
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Creates a file below a pinned directory without following an intermediate symlink. */
async function createPrivateFile(directory: string, name: string, content: string, mode: number): Promise<boolean> {
  const parent = await openPrivateDirectory(directory);
  try {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        `/proc/self/fd/${parent.fd}/${name}`,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        mode,
      );
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
    if (handle === undefined) throw new Error(`Could not create private file: ${directory}/${name}`);
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.chmod(mode);
    } finally {
      await handle.close().catch(() => {});
    }
    return true;
  } finally {
    await parent.close().catch(() => {});
  }
}

async function ensureWebSearchConfig(workspace: string): Promise<void> {
  await createPrivateFile(
    path.join(workspace, ".pi", "agent"),
    "web-search.json",
    '{"workflow":"none","autoOpenBrowser":false}\n',
    0o600,
  );
}

async function ensurePromptFile(appRoot: string, content: string): Promise<string> {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const promptDir = path.join(appRoot, ".prompts");
  await ensurePrivateDirectory(promptDir);
  const promptFile = path.join(promptDir, `prompt-${hash}.md`);
  await createPrivateFile(promptDir, path.basename(promptFile), content, 0o600);
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
  private closePromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private exitPromise: Promise<PiRunResult> | undefined;
  private terminatingChild: PiWorkerChildProcess | undefined;
  private terminatingPromise: Promise<void> | undefined;
  private readonly settledResolvers = new Set<{
    resolve: (result: PiRunResult) => void;
    reject: (error: Error) => void;
  }>();
  private readonly pendingResponses = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private reapedCallback: (() => void) | undefined;
  private closing = false;
  private stopped = false;
  private protocolLineError: Error | undefined;
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
    return this.protocolLineError === undefined && this.process !== undefined && this.process.exitCode === null && this.process.signalCode === null;
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
    if (this.protocolLineError) throw this.protocolLineError;
    this.ensureStartAllowed();
    if (this.isAlive()) return;
    if (this.startPromise) return this.startPromise;
    const starting = this.startInternal();
    this.startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = undefined;
    }
  }

  private ensureStartAllowed(): void {
    if (this.stopped) throw new Error("Pi RPC worker is stopped");
    if (this.closing) throw new Error("Pi RPC worker is closing");
  }

  private startupCancelled(): Error {
    return new Error(this.stopped ? "Pi RPC worker is stopped" : "Pi RPC worker is closing");
  }

  private async startInternal(): Promise<void> {
    this.ensureStartAllowed();
    this.stdout = "";
    this.stderr = "";
    this.lastActivityAt = 0;
    this.lastActivity = "";
    this.isBusyState = false;

    await prepareWorkspace(this.options.workspace);
    this.ensureStartAllowed();
    const promptFile = this.options.appendSystemPrompt !== undefined
      ? await ensurePromptFile(this.options.appRoot, this.options.appendSystemPrompt)
      : undefined;
    this.ensureStartAllowed();
    const built = await buildPiRunBwrapArgs({
      workspace: this.options.workspace,
      appRoot: this.options.appRoot,
      ...defined({
        cliPath: this.options.cliPath,
        appendSystemPrompt: promptFile,
        sessionDir: this.options.sessionDir,
        continueSession: this.options.continueSession,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        hostTools: this.options.hostTools,
        agentToken: this.options.agentToken,
        hostSocketDir: this.options.hostSocketDir,
        hostTimeline: this.options.hostTimeline,
        hostAttachments: this.options.hostAttachments,
      }),
    });
    this.ensureStartAllowed();

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
      let bufferBytes = 0;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const consumeStdout = (text: string): void => {
        if (text.length === 0 || this.protocolLineError) return;
        this.stdout = boundedCapture(this.stdout, text);
        let offset = 0;
        while (offset < text.length && !this.protocolLineError) {
          const newline = text.indexOf("\n", offset);
          const end = newline === -1 ? text.length : newline;
          const fragment = text.slice(offset, end);
          const fragmentBytes = Buffer.byteLength(fragment, "utf8");
          if (bufferBytes + fragmentBytes > MAX_PROTOCOL_LINE_BYTES) {
            this.failProtocolLine();
            return;
          }
          if (fragment.length > 0) {
            buffer += fragment;
            bufferBytes += fragmentBytes;
          }
          if (newline === -1) return;
          const line = buffer.trim();
          buffer = "";
          bufferBytes = 0;
          if (line.length > 0) this.handleStdoutLine(line);
          offset = newline + 1;
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
      child.stdin?.on("error", (error) => {
        if (this.closing || this.stopped || this.process !== child) return;
        const stdinError = asError(error);
        consumeStderr(stdinError.message);
        this.stopped = true;
        this.closing = true;
        this.clearIdleTimer();
        this.clearSteerWaitTimer();
        this.isBusyState = false;
        for (const pending of this.pendingResponses.values()) pending.reject(stdinError);
        this.pendingResponses.clear();
        this.rejectSettled(stdinError);
        void this.terminateOnce(child).catch(() => {});
      });
      child.once("error", (error) => consumeStderr(asError(error).message));
      child.once("close", (code, signal) => {
        consumeStdout(stdoutDecoder.end());
        consumeStderr(stderrDecoder.end());
        if (!this.protocolLineError && buffer.trim().length > 0) {
          this.handleStdoutLine(buffer.trim());
        }
        this.clearIdleTimer();
        this.clearSteerWaitTimer();
        this.isBusyState = false;
        this.process = undefined;
        const exitError = new Error(`Pi RPC exited before responding (code ${code ?? "unknown"}, signal ${signal ?? "none"})`);
        for (const pending of this.pendingResponses.values()) pending.reject(exitError);
        this.pendingResponses.clear();
        const result: PiRunResult = { code, signal, stderr: this.stderr, stdout: this.stdout };
        if (this.protocolLineError) this.rejectSettled(this.protocolLineError);
        else this.resolveSettled(result);
        resolve(result);
      });
    });
    if (this.stopped || this.closing) {
      await this.terminateOnce(child);
      throw this.startupCancelled();
    }

    try {
      await this.request({ id: "init-steer", type: "set_steering_mode", mode: "all" });
      this.ensureStartAllowed();
      await this.request({ id: "init-followup", type: "set_follow_up_mode", mode: "all" });
      this.ensureStartAllowed();
    } catch (error) {
      await this.terminateOnce(child).catch(() => {});
      this.process = undefined;
      throw error;
    }


    this.armIdleTimer();
  }

  private failProtocolLine(): void {
    if (this.protocolLineError) return;
    this.protocolLineError = new Error(`Pi RPC stdout line exceeded ${MAX_PROTOCOL_LINE_BYTES} bytes`);
    this.stopped = true;
    this.closing = true;
    this.clearIdleTimer();
    this.clearSteerWaitTimer();
    this.isBusyState = false;
    for (const pending of this.pendingResponses.values()) pending.reject(this.protocolLineError);
    this.pendingResponses.clear();
    this.rejectSettled(this.protocolLineError);
    const child = this.process;
    if (child) this.options.terminateProcessGroup(child, "SIGKILL");
  }

  private resolveSettled(result: PiRunResult): void {
    const resolvers = [...this.settledResolvers];
    this.settledResolvers.clear();
    for (const resolver of resolvers) {
      resolver.resolve(result);
    }
  }

  private rejectSettled(error: Error): void {
    const resolvers = [...this.settledResolvers];
    this.settledResolvers.clear();
    for (const resolver of resolvers) {
      resolver.reject(error);
    }
  }

  private handleStdoutLine(line: string): void {
    try {
      const event = JSON.parse(line) as { id?: unknown; type?: unknown; success?: unknown; error?: unknown; steering?: unknown };
      if (event.type === "response") {
        if (typeof event.id !== "string") return;
        const pending = this.pendingResponses.get(event.id);
        if (!pending) return;
        this.pendingResponses.delete(event.id);
        if (event.success === true) pending.resolve();
        else pending.reject(new Error(typeof event.error === "string" ? event.error : "Pi RPC request failed"));
        return;
      }
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


  private writeJson(obj: unknown): boolean {
    if (this.protocolLineError) return false;
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
  private request(command: { id: string; type: string; [key: string]: unknown }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingResponses.set(command.id, { resolve, reject });
      if (this.writeJson(command)) return;
      this.pendingResponses.delete(command.id);
      reject(new Error("Pi RPC stdin is unavailable"));
    });
  }


  async prompt(message: string, streamingBehavior?: "steer" | "followUp", maxWaitMs?: number): Promise<void> {
    if (this.protocolLineError) throw this.protocolLineError;
    if (this.stopped || this.closing) throw this.startupCancelled();
    if (!this.isAlive()) {
      await this.start();
    }
    const wasBusy = this.isBusyState;
    const queued = wasBusy && streamingBehavior === "steer";
    this.isBusyState = true;
    this.clearIdleTimer();
    this.noteActivity(message);
    const id = randomUUID();
    try {
      await this.request({
        id,
        type: "prompt",
        message,
        ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
      });
    } catch (error) {
      if (!wasBusy) {
        this.isBusyState = false;
        if (!this.closing) this.armIdleTimer();
      }
      throw error;
    }
    if (queued && maxWaitMs !== undefined) this.armSteerWaitTimer(maxWaitMs);
    if (!this.initialPromptWritten) {
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
      void this.request({ id: randomUUID(), type: "abort" }).catch(() => {});
    }, maxWaitMs);
    this.steerWaitTimer.unref?.();
  }

  private clearSteerWaitTimer(): void {
    if (this.steerWaitTimer !== undefined) this.clearTimeoutFn(this.steerWaitTimer);
    this.steerWaitTimer = undefined;
    this.steerWaitExpiresAt = undefined;
  }

  waitForSettled(): Promise<PiRunResult> {
    if (this.protocolLineError) return Promise.reject(this.protocolLineError);
    if (!this.isAlive()) {
      return this.exitPromise ?? Promise.resolve({ code: 0, signal: null, stderr: this.stderr, stdout: this.stdout });
    }
    if (!this.isBusyState) {
      return Promise.resolve({ code: 0, signal: null, stderr: this.stderr, stdout: this.stdout });
    }
    return new Promise<PiRunResult>((resolve, reject) => {
      this.settledResolvers.add({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = this.closeInternal();
    this.closePromise = closing;
    return closing;
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    this.clearSteerWaitTimer();
    this.clearIdleTimer();
    const starting = this.startPromise;
    const startingChild = this.process;
    if (starting && startingChild && this.isAlive()) await this.terminateOnce(startingChild);
    if (starting) await starting.catch(() => {});
    const child = this.process;
    if (!child || !this.isAlive()) return;
    await this.closeProcess(child);
  }

  private async closeProcess(child: PiWorkerChildProcess): Promise<void> {
    const done = this.exitPromise ?? Promise.resolve({ code: null, signal: null, stderr: "", stdout: "" });
    try {
      child.stdin?.end();
    } catch {
      await this.terminateOnce(child);
      return;
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
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.stopInternal();
    this.stopPromise = stopping;
    return stopping;
  }

  private async stopInternal(): Promise<void> {
    this.stopped = true;
    this.closing = true;
    this.clearSteerWaitTimer();
    this.clearIdleTimer();
    const starting = this.startPromise;
    const startingChild = this.process;
    if (starting && startingChild && this.isAlive()) await this.terminateOnce(startingChild);
    if (starting) await starting.catch(() => {});
    const child = this.process;
    if (!child || !this.isAlive()) return;
    await this.terminateOnce(child);
  }

  private terminateOnce(child: PiWorkerChildProcess): Promise<void> {
    if (this.terminatingChild === child && this.terminatingPromise) return this.terminatingPromise;
    const terminating = this.terminateProcess(child).finally(() => {
      if (this.terminatingChild === child) {
        this.terminatingChild = undefined;
        this.terminatingPromise = undefined;
      }
    });
    this.terminatingChild = child;
    this.terminatingPromise = terminating;
    return terminating;
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
