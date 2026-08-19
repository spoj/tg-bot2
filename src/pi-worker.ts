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

export type PiRunWorkerOptions = PiRunSandboxPaths & {
  /** The single message processed by the one-shot --print run. */
  message: string;
  bwrapPath?: string;
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
};

const DEFAULT_STOP_GRACE_MS = 1_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_SIGNAL_TIMEOUT_MS = 2_147_483_647;

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

async function prepareWorkspace(workspace: string): Promise<void> {
  await ensurePrivateDirectory(workspace);
  for (const relative of [
    ".pi",
    ".pi/agent",
    ".pi/sessions",
    ".tg-bot",
    ".tg-bot/outbox",
    ".tg-bot/task",
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
 * One-shot Pi run: executes a single --print turn in a fresh bwrap process and
 * resolves when the process exits. A live worker therefore always means an
 * active run; termination is the only out-of-band signal.
 */
export class PiRunWorker {
  private readonly options: PiRunWorkerOptions;
  private readonly bwrapPath: string;
  private readonly stopGraceMs: number;
  private process: PiWorkerChildProcess | undefined;
  private stdout = "";
  private stderr = "";

  constructor(options: PiRunWorkerOptions) {
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
  }

  /** Runs one turn to completion; resolves with the exit result. */
  async run(): Promise<PiRunResult> {
    if (this.process) throw new Error("Pi run worker is already running");
    this.stdout = "";
    this.stderr = "";
    try {
      return await this.runInternal();
    } finally {
      this.process = undefined;
    }
  }

  /** Terminates the run; the run() promise settles with the signal. */
  stop(): Promise<void> {
    const child = this.process;
    if (!child) return Promise.resolve();
    const done = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });
    this.options.terminateProcessGroup(child, "SIGTERM");
    const timer = setTimeout(() => {
      this.options.terminateProcessGroup(child, "SIGKILL");
    }, this.stopGraceMs);
    return done.finally(() => clearTimeout(timer));
  }

  private async runInternal(): Promise<PiRunResult> {
    await prepareWorkspace(this.options.workspace);
    const built = await buildPiRunBwrapArgs({
      workspace: this.options.workspace,
      appRoot: this.options.appRoot,
      ...defined({
        cliPath: this.options.cliPath,
        appendSystemPrompt: this.options.appendSystemPrompt,
        resume: this.options.resume,
        sessionDir: this.options.sessionDir,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
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

    const exited = new Promise<PiRunResult>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        this.stdout = boundedCapture(this.stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.stderr = boundedCapture(this.stderr, chunk);
      });
      child.once("exit", (code, signal) => {
        resolve({ code, signal, stderr: this.stderr, stdout: this.stdout });
      });
    });

    const stdin = child.stdin;
    if (!stdin) {
      this.options.terminateProcessGroup(child, "SIGKILL");
      throw new Error("Pi run stdin is unavailable");
    }
    try {
      stdin.end(this.options.message, "utf8");
    } catch {
      this.options.terminateProcessGroup(child, "SIGKILL");
    }
    return await exited;
  }
}