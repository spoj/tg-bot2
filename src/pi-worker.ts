import { watch, type FSWatcher } from "node:fs";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  buildPiWorkerBwrapArgs,
  buildPiWorkerEnvironment,
  spawnPiWorker,
  terminateProcessGroup,
  type PiWorkerChildProcess,
  type PiWorkerSandboxPaths,
  type PiWorkerSpawn,
} from "./sandbox.js";

export type { PiWorkerSpawn } from "./sandbox.js";

export type PiRpcEvent = Record<string, unknown>;
export type PiRpcEventListener = (event: PiRpcEvent) => void;

/** Parse strict LF-delimited JSONL; U+2028/U+2029 are data. */
export class StrictJsonlParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private lineNumber = 0;

  push(chunk: string | Buffer): unknown[] {
    this.buffer += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return this.drain(false);
  }

  end(): unknown[] {
    this.buffer += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): unknown[] {
    const records: unknown[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      records.push(this.parse(line));
    }
    if (final && this.buffer.length > 0) {
      records.push(this.parse(this.buffer));
      this.buffer = "";
    }
    return records;
  }

  private parse(line: string): unknown {
    this.lineNumber += 1;
    const json = line.endsWith("\r") ? line.slice(0, -1) : line;
    try {
      return JSON.parse(json) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Pi RPC JSON on line ${this.lineNumber}: ${message}`);
    }
  }
}

export type PiRpcWorkerOptions = PiWorkerSandboxPaths & {
  bwrapPath?: string;
  /** Test seam; production spawning stays in sandbox.ts. */
  spawn?: PiWorkerSpawn;
  stopGraceMs?: number;
  /** Bound RPCs so a silent worker cannot strand lifecycle operations. */
  rpcTimeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  workEpoch?: number;
  timeout?: ReturnType<typeof setTimeout>;
};
type SettledWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assistantText(event: JsonRecord): string | undefined {
  if (event.type !== "message_end") return undefined;
  const message = asRecord(event.message);
  if (!message || message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content.trim() || undefined;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();
  return text || undefined;
}


async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Pi worker runtime path must be a real directory: ${directory}`);
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

const EXTENSION_RELOAD_DEBOUNCE_MS = 500;
const EXTENSION_RELOAD_RETRY_MS = 100;

function extensionWatchKind(filename: string | Buffer | null): "settings" | "resource" | undefined {
  if (filename === null) return undefined;
  const relative = filename.toString().replaceAll(path.sep, "/");
  if (relative === "settings.json" || relative === "agent/settings.json") return "settings";
  if (
    relative === "extensions" || relative.startsWith("extensions/") ||
    relative === "npm" || relative.startsWith("npm/") ||
    relative === "agent/extensions" || relative.startsWith("agent/extensions/") ||
    relative === "agent/npm" || relative.startsWith("agent/npm/")
  ) return "resource";
  return undefined;
}

async function extensionSettingsFingerprint(workspace: string): Promise<string | undefined> {
  const settingsPaths = [
    path.join(workspace, ".pi", "settings.json"),
    path.join(workspace, ".pi", "agent", "settings.json"),
  ];
  const snapshots: unknown[] = [];
  for (const settingsPath of settingsPaths) {
    try {
      const parsed = asRecord(JSON.parse(await readFile(settingsPath, "utf8")));
      snapshots.push({ packages: parsed?.packages ?? null, extensions: parsed?.extensions ?? null });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        snapshots.push({ packages: null, extensions: null });
        continue;
      }
      return undefined;
    }
  }
  return JSON.stringify(snapshots);
}

async function prepareWorkspace(workspace: string): Promise<void> {
  await ensurePrivateDirectory(workspace);
  for (const relative of [
    ".pi",
    ".pi/agent",
    ".pi/sessions",
    ".tg-bot",
    ".tg-bot/outbox",
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

const IMMEDIATE_PROMPT_SETTLEMENT_MS = 50;
const DEFAULT_RPC_TIMEOUT_MS = 1_000;


export class PiRpcWorker {
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly bwrapPath: string;
  private readonly cliPath: string | undefined;
  private readonly appendSystemPrompt: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly stopGraceMs: number;
  private readonly rpcTimeoutMs: number;
  private process: PiWorkerChildProcess | undefined;
  private processDone: Promise<void> | undefined;
  private resolveProcessDone: (() => void) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<PiRpcEventListener>();
  private readonly settledWaiters = new Set<SettledWaiter>();
  private requestId = 0;
  private workEpoch = 0;
  private readonly unsettledWork = new Set<number>();
  private readonly acceptedWork = new Set<number>();
  private readonly startedWork = new Set<number>();
  private readonly settledBeforeAcceptance = new Set<number>();
  private readonly promptSettlementTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private parser: StrictJsonlParser | undefined;
  private lastAssistantText: string | undefined;
  private assistantTextKnown = false;
  private terminalError: Error | undefined;
  private stderr = "";
  private stopping = false;
  private lifecycleEpoch = 0;
  private extensionWatcher: FSWatcher | undefined;
  private extensionReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private extensionReloadPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopBarrierPromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private extensionSettingsFingerprint = "";
  private extensionResourceDirty = false;
  private extensionSettingsDirty = false;

  constructor(options: PiRpcWorkerOptions) {
    this.workspace = options.workspace;
    this.appRoot = options.appRoot;
    this.bwrapPath = options.bwrapPath ?? "bwrap";
    this.cliPath = options.cliPath;
    this.appendSystemPrompt = options.appendSystemPrompt;
    this.spawnProcess = options.spawn ?? spawnPiWorker;
    this.stopGraceMs = options.stopGraceMs ?? 1_000;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.stopGraceMs) || this.stopGraceMs < 0) {
      throw new Error("stopGraceMs must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.rpcTimeoutMs) || this.rpcTimeoutMs < 0) {
      throw new Error("rpcTimeoutMs must be a non-negative integer");
    }
  }
  private startExtensionWatcher(): void {
    const root = path.join(this.workspace, ".pi");
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      const kind = extensionWatchKind(filename);
      if (!kind) return;
      if (kind === "settings") this.extensionSettingsDirty = true;
      else this.extensionResourceDirty = true;
      this.scheduleExtensionReload();
    });
    watcher.on("error", () => {
      if (this.stopping) return;
      this.extensionResourceDirty = true;
      this.scheduleExtensionReload();
    });
    this.extensionWatcher = watcher;
  }

  private closeExtensionWatcher(): void {
    if (this.extensionReloadTimer) clearTimeout(this.extensionReloadTimer);
    this.extensionReloadTimer = undefined;
    const watcher = this.extensionWatcher;
    this.extensionWatcher = undefined;
    watcher?.close();
  }

  private scheduleExtensionReload(delayMs = EXTENSION_RELOAD_DEBOUNCE_MS): void {
    if (this.stopping || !this.process) return;
    if (this.extensionReloadTimer) clearTimeout(this.extensionReloadTimer);
    this.extensionReloadTimer = setTimeout(() => {
      this.extensionReloadTimer = undefined;
      void this.processExtensionReload();
    }, delayMs);
    this.extensionReloadTimer.unref?.();
  }

  private async processExtensionReload(): Promise<void> {
    if (this.extensionReloadPromise || this.stopping || !this.process) return;
    if (!this.extensionResourceDirty && !this.extensionSettingsDirty) return;
    const epoch = this.lifecycleEpoch;
    if (this.unsettledWork.size > 0 || this.pending.size > 0) {
      this.scheduleExtensionReload(EXTENSION_RELOAD_RETRY_MS);
      return;
    }
    try {
      const fingerprint = await extensionSettingsFingerprint(this.workspace);
      if (fingerprint === undefined) {
        this.scheduleExtensionReload(EXTENSION_RELOAD_RETRY_MS);
        return;
      }
      if (epoch !== this.lifecycleEpoch || this.stopping || !this.process || this.terminalError) return;
      const changed = this.extensionResourceDirty ||
        (this.extensionSettingsDirty && fingerprint !== this.extensionSettingsFingerprint);
      this.extensionResourceDirty = false;
      this.extensionSettingsDirty = false;
      if (!changed) return;
      const reload = this.reloadForExtensionChanges(epoch);
      this.extensionReloadPromise = reload;
      try {
        await reload;
      } finally {
        if (this.extensionReloadPromise === reload) this.extensionReloadPromise = undefined;
      }
    } catch (error) {
      this.terminalError ??= asError(error);
    }
  }

  private async reloadForExtensionChanges(epoch: number): Promise<void> {
    await this.stopProcess();
    if (epoch !== this.lifecycleEpoch || this.terminalError) return;
    await this.start();
  }

  private stopProcess(): Promise<void> {
    const existing = this.stopPromise;
    if (existing) return existing;
    let completion!: Promise<void>;
    completion = this.stopProcessInternal().finally(() => {
      if (this.stopPromise === completion) this.stopPromise = undefined;
    });
    this.stopPromise = completion;
    return completion;
  }

  private async stopProcessInternal(): Promise<void> {
    this.closeExtensionWatcher();
    const child = this.process;
    const done = this.processDone;
    if (!child || !done) {
      const stopped = this.terminalError ?? new Error("Pi worker stopped");
      this.clearPromptSettlementTimers();
      this.rejectPending(stopped);
      this.rejectSettledWaiters(stopped);
      this.unsettledWork.clear();
      this.acceptedWork.clear();
      this.startedWork.clear();
      this.settledBeforeAcceptance.clear();
      return;
    }
    this.stopping = true;
    terminateProcessGroup(child, "SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.stopGraceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (this.process === child) {
      const forcedStopError = new Error("Pi worker did not exit after SIGKILL");
      terminateProcessGroup(child, "SIGKILL");
      await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, this.stopGraceMs))]);
      if (this.process === child) {
        this.rejectPending(forcedStopError);
        this.rejectSettledWaiters(forcedStopError);
        this.finishProcess();
      }
    }
    this.clearPromptSettlementTimers();
    this.unsettledWork.clear();
    this.acceptedWork.clear();
    this.startedWork.clear();
    this.settledBeforeAcceptance.clear();
    this.process = undefined;
    this.processDone = undefined;
    this.resolveProcessDone = undefined;
  }

  async start(): Promise<void> {
    const stopping = this.stopBarrierPromise;
    if (stopping) await stopping;
    const stoppingProcess = this.stopPromise;
    if (stoppingProcess) await stoppingProcess;
    const existing = this.startPromise;
    if (existing) return existing;
    let completion!: Promise<void>;
    completion = this.startInternal().finally(() => {
      if (this.startPromise === completion) this.startPromise = undefined;
    });
    this.startPromise = completion;
    return completion;
  }

  private async startInternal(): Promise<void> {
    if (this.process) throw new Error("Pi worker is already started");
    if (this.terminalError) throw this.terminalError;
    this.lifecycleEpoch += 1;
    const epoch = this.lifecycleEpoch;
    await prepareWorkspace(this.workspace);
    this.extensionSettingsFingerprint = await extensionSettingsFingerprint(this.workspace) ?? "";
    this.extensionResourceDirty = false;
    this.extensionSettingsDirty = false;
    const built = await buildPiWorkerBwrapArgs({
      workspace: this.workspace,
      appRoot: this.appRoot,
      ...(this.cliPath === undefined ? {} : { cliPath: this.cliPath }),
      ...(this.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: this.appendSystemPrompt }),
    });
    if (epoch !== this.lifecycleEpoch) throw new Error("Pi worker start was superseded by stop");
    let child: PiWorkerChildProcess;
    try {
      child = this.spawnProcess(this.bwrapPath, built.args, {
        detached: true,
        env: buildPiWorkerEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = asError(error);
      this.terminalError = failure;
      throw failure;
    }
    this.stderr = "";
    this.lastAssistantText = undefined;
    this.assistantTextKnown = false;
    this.workEpoch = 0;
    this.unsettledWork.clear();
    this.acceptedWork.clear();
    this.startedWork.clear();
    this.settledBeforeAcceptance.clear();
    this.clearPromptSettlementTimers();
    this.process = child;
    this.stopping = false;
    this.parser = new StrictJsonlParser();
    this.processDone = new Promise<void>((resolve) => { this.resolveProcessDone = resolve; });
    const stdin = child.stdin;
    if (!stdin) {
      const failure = new Error(`Pi worker stdin is unavailable. Stderr: ${this.stderr}`);
      this.failProcess(failure);
      throw failure;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      try {
        for (const record of this.parser?.push(chunk) ?? []) this.handleRecord(record);
      } catch (error) {
        this.failProcess(asError(error));
      }
    });
    child.stdout?.on("end", () => {
      try {
        for (const record of this.parser?.end() ?? []) this.handleRecord(record);
      } catch (error) {
        this.failProcess(asError(error));
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (error) => {
      this.failProcess(new Error(`Pi worker process error: ${error.message}. Stderr: ${this.stderr}`));
    });
    child.once("exit", (code, signal) => this.handleExit(code, signal));
    child.once("close", (code, signal) => this.handleExit(code, signal));
    stdin.once("error", (error) => {
      this.failProcess(new Error(`Pi worker stdin error: ${error.message}. Stderr: ${this.stderr}`));
    });
    if (child.exitCode !== null) {
      this.handleExit(child.exitCode, child.signalCode);
      throw this.terminalError ?? new Error("Pi worker exited during startup");
    }
    try {
      this.startExtensionWatcher();
    } catch (error) {
      const failure = asError(error);
      this.failProcess(failure);
      throw failure;
    }
  }
  async stop(): Promise<void> {
    this.lifecycleEpoch += 1;
    const existing = this.stopBarrierPromise;
    if (existing) {
      await existing;
      return;
    }
    const starting = this.startPromise;
    let completion!: Promise<void>;
    completion = (async () => {
      if (starting) await starting.catch(() => {});
      await this.stopProcess();
    })().finally(() => {
      if (this.stopBarrierPromise === completion) this.stopBarrierPromise = undefined;
    });
    this.stopBarrierPromise = completion;
    await completion;
  }
  async abort(): Promise<void> {
    try {
      await this.request({ type: "abort" }, undefined, this.rpcTimeoutMs);
      this.settleAllWork();
    } catch (error) {
      const failure = asError(error);
      this.failProcess(failure);
      throw failure;
    }
  }

  async newSession(): Promise<void> {
    const reload = this.extensionReloadPromise;
    if (reload) await reload;
    const response = await this.request({ type: "new_session" });
    const record = asRecord(response);
    const data = asRecord(record?.data);
    if (data?.cancelled === true) throw new Error("Pi worker new session was cancelled");
    this.lastAssistantText = undefined;
    this.assistantTextKnown = false;
  }

  async prompt(message: string): Promise<void> {
    const reload = this.extensionReloadPromise;
    if (reload) await reload;
    await this.queueWork({ type: "prompt", message });
  }

  async steer(message: string): Promise<void> {
    const reload = this.extensionReloadPromise;
    if (reload) await reload;
    await this.queueWork({ type: "steer", message });
  }


  async waitForSettled(): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (this.unsettledWork.size === 0) return;
    return await new Promise<void>((resolve, reject) => {
      this.settledWaiters.add({ resolve, reject });
    });
  }

  async getLastAssistantText(): Promise<string | undefined> {
    const reload = this.extensionReloadPromise;
    if (reload) await reload;
    if (this.assistantTextKnown) return this.lastAssistantText;
    const response = await this.request({ type: "get_last_assistant_text" });
    const record = asRecord(response);
    const data = asRecord(record?.data);
    const text = data?.text;
    this.lastAssistantText = typeof text === "string" ? text.trim() || undefined : undefined;
    this.assistantTextKnown = true;
    return this.lastAssistantText;
  }

  onEvent(listener: PiRpcEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }


  private async queueWork(command: JsonRecord): Promise<void> {
    const epoch = ++this.workEpoch;
    this.unsettledWork.add(epoch);
    try {
      await this.request(command, epoch);
      if (command.type === "prompt") this.schedulePromptSettlementProbe(epoch);
    } catch (error) {
      this.settleWork(epoch);
      throw error;
    }
  }

  private request(command: JsonRecord, workEpoch?: number, timeoutMs?: number): Promise<unknown> {
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || !stdin || this.terminalError) {
      return Promise.reject(this.terminalError ?? new Error("Pi worker is not started"));
    }
    const id = `pi-rpc-${++this.requestId}`;
    const line = `${JSON.stringify({ id, ...command })}\n`;
    const effectiveTimeout = timeoutMs ?? this.rpcTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        ...(workEpoch === undefined ? {} : { workEpoch }),
      };
      this.pending.set(id, pending);
      pending.timeout = setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        const failure = new Error(`Pi RPC ${String(command.type)} request timed out`);
        pending.reject(failure);
        if (pending.workEpoch !== undefined) this.failProcess(failure);
      }, effectiveTimeout);
      pending.timeout.unref?.();
      try {
        stdin.write(line);
      } catch (error) {
        this.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        reject(asError(error));
      }
    });
  }
  private schedulePromptSettlementProbe(epoch: number): void {
    if (!this.unsettledWork.has(epoch)) return;
    const timer = setTimeout(() => {
      this.promptSettlementTimers.delete(epoch);
      void this.request({ type: "get_state" }, undefined, IMMEDIATE_PROMPT_SETTLEMENT_MS).then((response) => {
        if (!this.unsettledWork.has(epoch) || this.startedWork.has(epoch)) return;
        const record = asRecord(response);
        const data = asRecord(record?.data);
        if (data?.isStreaming === false && data.pendingMessageCount === 0) this.settleWork(epoch);
      }).catch((error) => {
        if (this.unsettledWork.has(epoch)) this.failProcess(asError(error));
      });
    }, IMMEDIATE_PROMPT_SETTLEMENT_MS);
    timer.unref?.();
    this.promptSettlementTimers.set(epoch, timer);
  }

  private settleAllWork(): void {
    for (const epoch of [...this.unsettledWork]) this.settleWork(epoch);
    this.acceptedWork.clear();
    this.startedWork.clear();
    this.settledBeforeAcceptance.clear();
  }

  private settleWork(epoch: number): void {
    this.clearPromptSettlementTimer(epoch);
    this.unsettledWork.delete(epoch);
    this.acceptedWork.delete(epoch);
    this.startedWork.delete(epoch);
    this.settledBeforeAcceptance.delete(epoch);
    if (this.unsettledWork.size === 0) {
      this.resolveSettledWaiters();
    }
  }

  private clearPromptSettlementTimer(epoch: number): void {
    const timer = this.promptSettlementTimers.get(epoch);
    if (timer) clearTimeout(timer);
    this.promptSettlementTimers.delete(epoch);
  }

  private clearPromptSettlementTimers(): void {
    for (const timer of this.promptSettlementTimers.values()) clearTimeout(timer);
    this.promptSettlementTimers.clear();
  }

  private markAgentProgress(): void {
    for (const epoch of this.acceptedWork) this.startedWork.add(epoch);
  }

  private isAgentProgressEvent(type: unknown): boolean {
    return [
      "agent_start", "turn_start", "message_start", "message_update", "message_end",
      "tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_end",
    ].includes(String(type));
  }


  private handleRecord(value: unknown): void {
    const record = asRecord(value);
    if (!record) return;
    if (record.type === "response") {
      const id = record.id;
      if (typeof id !== "string") return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (record.success === true) {
        if (pending.workEpoch !== undefined && this.unsettledWork.has(pending.workEpoch)) {
          this.acceptedWork.add(pending.workEpoch);
          if (this.settledBeforeAcceptance.has(pending.workEpoch)) this.settleWork(pending.workEpoch);
        }
        pending.resolve(record);
      } else {
        pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi RPC command failed"));
      }
      return;
    }
    const text = assistantText(record);
    if (record.type === "message_end") {
      const message = asRecord(record.message);
      if (message?.role === "assistant") {
        this.lastAssistantText = text;
        this.assistantTextKnown = true;
      }
    }
    if (record.type === "agent_settled") {
      for (const epoch of [...this.unsettledWork]) {
        if (this.acceptedWork.has(epoch)) this.settleWork(epoch);
        else this.settledBeforeAcceptance.add(epoch);
      }
    } else if (this.isAgentProgressEvent(record.type)) {
      this.markAgentProgress();
    }
    for (const listener of this.listeners) {
      try { listener(record); } catch { /* listeners cannot break the RPC pump */ }
    }
    if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(record.method))) {
      const id = record.id;
      if (typeof id === "string") this.writeFireAndForget({ type: "extension_ui_response", id, cancelled: true });
    }
  }

  private writeFireAndForget(value: JsonRecord): void {
    const stdin = this.process?.stdin;
    if (!stdin) return;
    try { stdin.write(`${JSON.stringify(value)}\n`); } catch { /* process exit handles write failure */ }
  }

  private failProcess(error: Error): void {
    if (!this.terminalError && !this.stopping) this.terminalError = error;
    this.clearPromptSettlementTimers();
    this.rejectPending(error);
    this.rejectSettledWaiters(error);
    this.settleAllWork();
    const child = this.process;
    if (child && !this.stopping) terminateProcessGroup(child, "SIGKILL");
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = this.terminalError ?? new Error(
      `Pi worker exited (${signal ?? (code === null ? "unknown" : code)}).${this.stderr ? ` Stderr: ${this.stderr}` : ""}`,
    );
    this.clearPromptSettlementTimers();
    this.rejectPending(error);
    this.rejectSettledWaiters(error);
    this.settleAllWork();
    if (!this.stopping && !this.terminalError) this.terminalError = error;
    this.process = undefined;
    this.finishProcess();
  }

  private finishProcess(): void {
    this.resolveProcessDone?.();
    this.resolveProcessDone = undefined;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resolveSettledWaiters(): void {
    for (const waiter of this.settledWaiters) waiter.resolve();
    this.settledWaiters.clear();
  }

  private rejectSettledWaiters(error: Error): void {
    for (const waiter of this.settledWaiters) waiter.reject(error);
    this.settledWaiters.clear();
  }
}
