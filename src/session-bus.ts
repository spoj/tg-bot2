import { constants as fsConstants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { chatPaths, isMissing, numericChatId, openPinnedDirectory, readJsonl, type PinnedDirectory } from "./util.js";

/**
 * A tool call recorded in a Pi session file — the agent's append-only log. The host
 * consumes these calls and executes the real work, so every host action traces back to
 * one immutable (sessionId, recordId, contentIndex) reference.
 */
export type SessionCallRef = {
  sessionId: string;
  recordId: string;
  index: number;
};

export type HostToolName = "send" | "spawn" | "cancel";

export type SessionToolCall = {
  ref: SessionCallRef;
  name: HostToolName;
  args: Record<string, unknown>;
};

/** Consumes one send call. `resume` carries the requestId of an outbox_claimed event whose dispatch never reached a terminal event. */
export type SendHandler = (
  call: SessionToolCall,
  chatId: number,
  workspace: string,
  resume: { requestId: string } | undefined,
) => Promise<void>;

/** Consumes one spawn call; "pending" means the chat is at capacity and the call must be retried. */
export type SpawnHandler = (
  call: SessionToolCall,
  chatId: number,
  workspace: string,
) => Promise<"claimed" | "pending">;

/** Consumes one cancel call; a call with no matching in-flight run is a no-op. */
export type CancelHandler = (call: SessionToolCall, chatId: number, workspace: string) => Promise<void>;

export type WorkspaceSessionBusOptions = {
  dataDir: string;
  onSend: SendHandler;
  onSpawn: SpawnHandler;
  onCancel: CancelHandler;
  pollIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: (error: unknown) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
const SESSIONS_DIR = path.join(".pi", "sessions");
const TASKS_DIR = path.join(".pi", "tasks");
const TASK_SESSIONS_DIR = "sessions";
const SYSTEM_LOG = path.join(".tg-bot", "system.jsonl");
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const SESSION_FILE = /^.*_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const NON_BLOCKING = fsConstants.O_NONBLOCK;

type ChatScanState = {
  /** Per-file byte offset; session files are append-only, so offsets are stable for a process lifetime. */
  offsets: Map<string, number>;
  /** Trailing fragment of a record still being written, per file. */
  partials: Map<string, string>;
  /** Calls routed this lifetime. */
  consumed: Set<string>;
  /** Calls already recorded in system.jsonl (claims and terminals); never re-emitted. */
  bootConsumed: Set<string>;
  /** Open outbox claims (claimed, no terminal): refKey -> requestId; re-dispatched at boot. */
  sendResume: Map<string, string>;
  /** Spawn calls awaiting a free slot. */
  pending: SessionToolCall[];
  booted: boolean;
};

function refKey(ref: SessionCallRef): string {
  return `${ref.sessionId}:${ref.recordId}:${ref.index}`;
}

function sessionIdFromPath(filePath: string): string | undefined {
  return SESSION_FILE.exec(path.basename(filePath))?.[1];
}

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

async function sessionFilesIn(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readDirEntries(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && SESSION_FILE.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

/** All session files in a workspace: the chat's own sessions plus every task run's sessions. */
async function discoverSessionFiles(workspace: string): Promise<string[]> {
  const files = await sessionFilesIn(path.join(workspace, SESSIONS_DIR));
  const tasksRoot = path.join(workspace, TASKS_DIR);
  let runDirs: Dirent[];
  try {
    runDirs = await readDirEntries(tasksRoot);
  } catch (error) {
    if (isMissing(error)) return files;
    throw error;
  }
  for (const run of runDirs.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      files.push(...await sessionFilesIn(path.join(tasksRoot, run.name, TASK_SESSIONS_DIR)));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return files;
}

/** Reads bytes after offset without following symlinks; a planted symlink throws ELOOP and the file is skipped. */
async function readSessionTail(filePath: string, offset: number): Promise<{ text: string; nextOffset: number }> {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { text: "", nextOffset: offset };
    // The harness occasionally rewrites session files wholesale (version migration,
    // compaction). A size below the stored offset means the file was rewritten:
    // rescan from the top; the claim-check keeps already-consumed calls deduped.
    const start = stat.size < offset ? 0 : offset;
    if (stat.size <= start) return { text: "", nextOffset: start };
    const length = stat.size - start;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, start + read);
      read += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    return { text: buffer.subarray(0, read).toString("utf8"), nextOffset: start + read };
  } finally {
    await handle.close();
  }
}

/**
 * Splits newly read text into complete records and one deferred trailing fragment.
 * A fragment without a newline is emitted only when it already parses as complete JSON;
 * otherwise it is held until the next read completes it.
 */
export function splitRecords(text: string): { lines: string[]; partial: string } {
  const index = text.lastIndexOf("\n");
  const parseComplete = (fragment: string): boolean => {
    if (fragment.length === 0) return false;
    try {
      JSON.parse(fragment);
      return true;
    } catch {
      return false;
    }
  };
  if (index === -1) {
    return parseComplete(text) ? { lines: [text], partial: "" } : { lines: [], partial: text };
  }
  const lines = text.slice(0, index).split("\n");
  const tail = text.slice(index + 1);
  if (tail === "") return { lines, partial: "" };
  return parseComplete(tail) ? { lines: [...lines, tail], partial: "" } : { lines, partial: tail };
}

/** Extracts host tool calls from one session record; returns [] for non-assistant records or unknown tools. */
export function extractToolCalls(sessionId: string, line: string): SessionToolCall[] {
  if (line.length > MAX_RECORD_BYTES) return [];
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return [];
  const typed = record as Record<string, unknown>;
  if (typed.type !== "message") return [];
  const recordId = typed.id;
  if (typeof recordId !== "string" || recordId.length === 0) return [];
  const message = typed.message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return [];
  if ((message as Record<string, unknown>).role !== "assistant") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const calls: SessionToolCall[] = [];
  content.forEach((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return;
    const part = item as Record<string, unknown>;
    if (part.type !== "toolCall") return;
    const name = part.name;
    if (name !== "send" && name !== "spawn" && name !== "cancel") return;
    const args = part.arguments;
    const argsObject = args !== null && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    calls.push({ ref: { sessionId, recordId, index }, name, args: argsObject });
  });
  return calls;
}

/** The callRef of a system.jsonl event, when it carries a well-formed one. */
function bootCallRef(record: Record<string, unknown>): SessionCallRef | undefined {
  const ref = record.callRef;
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return undefined;
  const refRecord = ref as Record<string, unknown>;
  if (typeof refRecord.sessionId !== "string" || typeof refRecord.recordId !== "string" || typeof refRecord.index !== "number") return undefined;
  return { sessionId: refRecord.sessionId, recordId: refRecord.recordId, index: refRecord.index };
}

/** Folds one system.jsonl event into the boot claim state. */
function applyBootEvent(record: Record<string, unknown>, state: ChatScanState, openSends: Map<string, string>): void {
  const ref = bootCallRef(record);
  if (ref === undefined) return;
  const key = refKey(ref);
  switch (record.type) {
    case "outbox_claimed": {
      const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
      if (requestId !== undefined) openSends.set(key, requestId);
      break;
    }
    case "outbox_sent":
    case "outbox_rejected":
      openSends.delete(key);
      state.bootConsumed.add(key);
      break;
    case "task_claimed":
    case "task_cancelled":
      state.bootConsumed.add(key);
      break;
    default:
      break;
  }
}
/**
 * Consumes host tool calls from every session file in every chat workspace: tails the
 * agent's append-only session logs, extracts send/spawn/cancel calls, dedupes against
 * system.jsonl claims, and routes each call to its handler exactly once. Boot replay
 * re-dispatches open outbox claims (claimed without a terminal event) and re-discovers
 * unclaimed calls; spawn calls over a chat's concurrency limit are retried each poll.
 */
export class WorkspaceSessionBus {
  private readonly options: Required<Pick<WorkspaceSessionBusOptions, "onSend" | "onSpawn" | "onCancel">> & WorkspaceSessionBusOptions;
  private readonly dataDir: string;
  private readonly pollIntervalMs: number;
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private readonly states = new Map<number, ChatScanState>();
  private timer: NodeJS.Timeout | undefined;
  private pollInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceSessionBusOptions) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_TIMER_MS) {
      throw new Error("Session poll interval must be a positive timer-safe integer");
    }
    this.options = options;
    this.dataDir = path.resolve(options.dataDir);
    this.pollIntervalMs = pollIntervalMs;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Session bus error", error));
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
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    const pending: Promise<void>[] = [];
    if (this.startInFlight) pending.push(this.startInFlight);
    if (this.pollInFlight) pending.push(this.pollInFlight);
    if (pending.length > 0) await Promise.all(pending.map((operation) => operation.catch(() => {})));
  }

  /** Polls every chat workspace; concurrent calls share one operation. */
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

  /** Consumes any calls written since the last scan of one task run's sessions. */
  async flushTaskRun(chatId: number, workspace: string, runId: string): Promise<void> {
    if (!Number.isSafeInteger(chatId)) return;
    const state = await this.ensureState(chatId, workspace);
    const directory = path.join(workspace, TASKS_DIR, runId, TASK_SESSIONS_DIR);
    let files: string[];
    try {
      files = await sessionFilesIn(directory);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
      return;
    }
    for (const file of files) {
      await this.scanFile(chatId, workspace, state, file);
    }
  }

  private async ensureState(chatId: number, workspace: string): Promise<ChatScanState> {
    const existing = this.states.get(chatId);
    if (existing) return existing;
    const state: ChatScanState = {
      offsets: new Map(),
      partials: new Map(),
      consumed: new Set(),
      bootConsumed: new Set(),
      sendResume: new Map(),
      pending: [],
      booted: false,
    };
    this.states.set(chatId, state);
    await this.loadBootState(workspace, state);
    state.booted = true;
    return state;
  }


  /** Rebuilds claim state from system.jsonl so boot replay neither re-dispatches settled calls nor drops open ones. */
  private async loadBootState(workspace: string, state: ChatScanState): Promise<void> {
    let lines: string[];
    try {
      lines = await readJsonl(path.join(workspace, SYSTEM_LOG));
    } catch (error) {
      if (!isMissing(error)) this.report(error);
      return;
    }
    const openSends = new Map<string, string>();
    for (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
      applyBootEvent(record as Record<string, unknown>, state, openSends);
    }
    for (const [key, requestId] of openSends) state.sendResume.set(key, requestId);
  }

  private async runPoll(): Promise<void> {
    let chatsRoot: PinnedDirectory | undefined;
    try {
      chatsRoot = await openPinnedDirectory(path.join(this.dataDir, "chats"));
      const entries = await readDirEntries(chatsRoot.path);
      const chats = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => numericChatId(entry.name))
        .filter((chatId): chatId is number => chatId !== undefined)
        .sort((a, b) => a - b);
      for (const chatId of chats) {
        const workspace = chatPaths(this.dataDir, chatId).workspace;
        try {
          await this.scanChat(chatId, workspace);
        } catch (error) {
          if (!isMissing(error)) this.report(error);
        }
      }
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    } finally {
      if (chatsRoot) await chatsRoot.handle.close().catch((error) => this.report(error));
    }
  }

  private async scanChat(chatId: number, workspace: string): Promise<void> {
    const state = await this.ensureState(chatId, workspace);
    // Retry spawns left pending by the previous poll before scanning new calls.
    const pending = state.pending;
    state.pending = [];
    for (const call of pending) {
      const result = await this.invokeSpawn(chatId, workspace, call);
      if (result === "claimed") state.consumed.add(refKey(call.ref));
      else state.pending.push(call);
    }
    let files: string[];
    try {
      files = await discoverSessionFiles(workspace);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
      return;
    }
    for (const file of files) {
      await this.scanFile(chatId, workspace, state, file);
    }
  }

  private async scanFile(chatId: number, workspace: string, state: ChatScanState, file: string): Promise<void> {
    const previous = state.offsets.get(file) ?? 0;
    let tail: { text: string; nextOffset: number };
    try {
      tail = await readSessionTail(file, previous);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
      return;
    }
    if (tail.nextOffset < previous) state.partials.delete(file);
    state.offsets.set(file, tail.nextOffset);
    const combined = (state.partials.get(file) ?? "") + tail.text;
    const { lines, partial } = splitRecords(combined);
    state.partials.set(file, partial);
    const sessionId = sessionIdFromPath(file);
    if (sessionId === undefined) return;
    for (const line of lines) {
      for (const call of extractToolCalls(sessionId, line)) {
        await this.route(chatId, workspace, state, call);
      }
    }
  }

  private async route(chatId: number, workspace: string, state: ChatScanState, call: SessionToolCall): Promise<void> {
    const key = refKey(call.ref);
    if (state.consumed.has(key)) return;
    if (state.bootConsumed.has(key)) {
      state.consumed.add(key);
      return;
    }
    const resume = state.sendResume.get(key);
    if (call.name === "send") {
      state.consumed.add(key);
      if (resume !== undefined) await this.invoke(() => this.options.onSend(call, chatId, workspace, { requestId: resume }));
      else await this.invoke(() => this.options.onSend(call, chatId, workspace, undefined));
      return;
    }
    if (call.name === "spawn") {
      const result = await this.invokeSpawn(chatId, workspace, call);
      if (result === "claimed") state.consumed.add(key);
      else state.pending.push(call);
      return;
    }
    state.consumed.add(key);
    await this.invoke(() => this.options.onCancel(call, chatId, workspace));
  }

  private async invoke(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.report(error);
    }
  }

  private async invokeSpawn(chatId: number, workspace: string, call: SessionToolCall): Promise<"claimed" | "pending"> {
    try {
      return await this.options.onSpawn(call, chatId, workspace);
    } catch (error) {
      this.report(error);
      return "claimed";
    }
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt session consumption.
    }
  }
}
