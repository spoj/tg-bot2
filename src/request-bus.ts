import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { TG_BOT_DIR, defined, isMissing, readJsonl } from "./util.js";
import { EVENTS_FILE, type AgentCommand } from "./events.js";

/** One send_request command: the agent's tool minted requestId and the raw request object. */
export type SendRequest = Extract<AgentCommand, { type: "send_request" }>;

/** One spawn_request command: the agent's tool minted runId and the complete prompt. */
export type SpawnRequest = Extract<AgentCommand, { type: "spawn_request" }>;

/** One cancel_request command: the runId of a previously spawned task. */
export type CancelRequest = Extract<AgentCommand, { type: "cancel_request" }>;

/** One steer_task_request command: the agent's tool minted steerId, target runId, and steering message. */
export type SteerTaskRequest = Extract<AgentCommand, { type: "steer_task_request" }>;

/** One browser_requested command: the agent's tool minted requestId. */
export type StartBrowserRequest = Extract<AgentCommand, { type: "browser_requested" }>;
/** One new_session_request command to reset conversational context. */
export type NewSessionRequest = Extract<AgentCommand, { type: "new_session_request" }>;
/** Consumes one send_request; `resume` means the command was claimed but its dispatch never reached a terminal event. */
export type SendRequestHandler = (
  record: SendRequest,
  workspace: string,
) => Promise<void>;
/** Consumes one spawn_request; "pending" means the task slots are at capacity and the command must be retried. */
export type SpawnRequestHandler = (
  record: SpawnRequest,
  workspace: string,
) => Promise<"claimed" | "pending">;

/** Consumes one cancel_request; a command naming an unknown or settled run is a no-op. */
export type CancelRequestHandler = (record: CancelRequest, workspace: string) => Promise<void>;
/** Consumes one steer_task_request; a command naming an unknown or settled run is a no-op. */
export type SteerTaskRequestHandler = (record: SteerTaskRequest, workspace: string) => Promise<void>;

/** Consumes one browser_requested command to start Chrome and the socket bridge. */
export type StartBrowserRequestHandler = (record: StartBrowserRequest, workspace: string) => Promise<void>;
/** Consumes one new_session_request command to reset the agent session. */
export type NewSessionRequestHandler = (record: NewSessionRequest, workspace: string) => Promise<void>;

export type WorkspaceRequestBusOptions = {
  workspace: string;
  onSend: SendRequestHandler;
  onSpawn: SpawnRequestHandler;
  onCancel: CancelRequestHandler;
  onSteerTask?: SteerTaskRequestHandler;
  onStartBrowser?: StartBrowserRequestHandler;
  onNewSession?: NewSessionRequestHandler;
  pollIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: (error: unknown) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
const EVENTS_LOG = path.join(TG_BOT_DIR, EVENTS_FILE);
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
type ChatScanState = {
  /** Byte offset into events.jsonl; the log is append-only, so offsets are stable for a process lifetime. */
  offset: number;
  /** Trailing fragment of a record still being written. */
  partial: string;
  /** Commands routed this lifetime, by UUID. */
  consumed: Set<string>;
  /** UUIDs already terminated in events.jsonl; never re-routed. */
  bootConsumed: Set<string>;
  /** Spawn commands awaiting a free slot. */
  pending: SpawnRequest[];
  booted: boolean;
};

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function commandId(type: string, record: Record<string, unknown>): string | undefined {
  const id = record[
    type === "send_request" || type === "browser_requested" || type === "new_session_request" ? "requestId"
      : type === "steer_task_request" ? "steerId"
        : "runId"
  ];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
export type CommandRequest = AgentCommand;

/** Parses one events.jsonl line into a command record; undefined for outcomes, junk, or malformed commands. */
export function parseCommand(line: string): CommandRequest | undefined {
  if (line.length > MAX_RECORD_BYTES) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const typed = record as Record<string, unknown>;
  const id = commandId(typed.type as string, typed);
  if (id === undefined) return undefined;
  switch (typed.type) {
    case "send_request":
      return { type: "send_request", requestId: id, request: typed.request };
    case "spawn_request":
    case "schedule_run_fired": {
      const prompt = typed.prompt;
      return typeof prompt === "string" ? { type: "spawn_request", runId: id, prompt } : undefined;
    }
    case "steer_task_request": {
      const runId = typed.runId;
      const message = typed.message;
      return typeof runId === "string" && typeof message === "string" && runId.length > 0
        ? { type: "steer_task_request", steerId: id, runId, message }
        : undefined;
    }
    case "cancel_request":
      return { type: "cancel_request", runId: id };
    case "browser_requested":
      return { type: "browser_requested", requestId: id };
    case "new_session_request":
      return {
        type: "new_session_request",
        requestId: id,
        ...defined({
          chat_id: safeInteger(typed.chat_id),
          message_thread_id: safeInteger(typed.message_thread_id),
        }),
      };
    default:
      return undefined;
  }
}



/** Reads bytes after offset without following symlinks; a planted symlink throws ELOOP and the file is skipped. */
async function readTail(filePath: string, offset: number): Promise<{ text: string; nextOffset: number }> {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { text: "", nextOffset: offset };
    // The agent can truncate anything in its workspace, including events.jsonl.
    // A size below the stored offset means the file was truncated: rescan from the
    // top; the claim fold keeps already-consumed commands deduped.
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

/**
 * Consumes agent commands from the shared events.jsonl: tails the append-only log,
 * extracts send_request/spawn_request/cancel_request records, dedupes against the
 * claim events in the same log, and routes each command to its handler exactly once.
 * Boot replay re-dispatches open outbox claims (claimed without a terminal event);
 * spawn commands over the task concurrency limit are retried each poll. The agent's
 * tools append commands with O_APPEND; the host's outcome appends interleave safely.
 */
export class WorkspaceRequestBus {
  private readonly options: Required<Pick<WorkspaceRequestBusOptions, "onSend" | "onSpawn" | "onCancel">> & WorkspaceRequestBusOptions;
  private readonly workspace: string;
  private readonly pollIntervalMs: number;
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private state: ChatScanState | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pollInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceRequestBusOptions) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_TIMER_MS) {
      throw new Error("Request poll interval must be a positive timer-safe integer");
    }
    this.options = options;
    this.workspace = path.resolve(options.workspace);
    this.pollIntervalMs = pollIntervalMs;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Request bus error", error));
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

  /** Consumes any commands written since the last scan, so settle followups order after a task's sends. */
  async flush(workspace: string): Promise<void> {
    const state = await this.ensureState(workspace);
    await this.scanWorkspace(workspace, state, false);
  }

  private async ensureState(workspace: string): Promise<ChatScanState> {
    if (this.state) return this.state;
    const state: ChatScanState = {
      offset: 0,
      partial: "",
      consumed: new Set(),
      bootConsumed: new Set(),
      pending: [],
      booted: false,
    };
    this.state = state;
    await this.loadBootState(workspace, state);
    return state;
  }

  /** Rebuilds terminal outcome state from events.jsonl so boot replay skips completed commands. */
  private async loadBootState(workspace: string, state: ChatScanState): Promise<void> {
    let lines: string[];
    try {
      lines = await readJsonl(path.join(workspace, EVENTS_LOG));
    } catch (error) {
      if (!isMissing(error)) this.report(error);
      return;
    }
    for (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
      const typed = record as Record<string, unknown>;
      const id = typeof typed.requestId === "string" && typed.requestId.length > 0 ? typed.requestId
        : typeof typed.runId === "string" && typed.runId.length > 0 ? typed.runId
          : undefined;
      if (id === undefined) continue;
      if (
        typed.type === "outbox_sent" ||
        typed.type === "outbox_rejected" ||
        typed.type === "task_settled" ||
        typed.type === "browser_ready" ||
        typed.type === "browser_request_failed" ||
        typed.type === "new_session_scheduled"
      ) {
        state.bootConsumed.add(id);
      }
    }
  }

  private async runPoll(): Promise<void> {
    try {
      const state = await this.ensureState(this.workspace);
      await this.scanWorkspace(this.workspace, state, true);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    }
  }

  private async scanWorkspace(workspace: string, state: ChatScanState, retryPending: boolean): Promise<void> {
    // Retry spawns left pending by the previous poll before scanning new commands.
    if (retryPending) {
      const pending = state.pending;
      state.pending = [];
      for (const record of pending) {
        const result = await this.invokeSpawn(workspace, record);
        if (result === "claimed") state.consumed.add(record.runId);
        else state.pending.push(record);
      }
    }
    const file = path.join(workspace, EVENTS_LOG);
    const previous = state.offset;
    let tail: { text: string; nextOffset: number };
    try {
      tail = await readTail(file, previous);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
      return;
    }
    if (tail.nextOffset < previous) state.partial = "";
    state.offset = tail.nextOffset;
    const { lines, partial } = splitRecords(state.partial + tail.text);
    state.partial = partial;
    for (const line of lines) {
      const record = parseCommand(line);
      if (record === undefined) continue;
      await this.route(workspace, state, record);
    }
  }
  private async route(workspace: string, state: ChatScanState, record: CommandRequest): Promise<void> {
    const id = "requestId" in record ? record.requestId : "steerId" in record ? record.steerId : "runId" in record ? record.runId : undefined;
    if (id && state.bootConsumed.has(id)) {
      state.consumed.add(id);
      return;
    }
    switch (record.type) {
      case "send_request":
        state.consumed.add(id!);
        await this.invoke(() => this.options.onSend(record, workspace));
        break;
      case "spawn_request": {
        const result = await this.invokeSpawn(workspace, record);
        if (result === "claimed") state.consumed.add(record.runId);
        else state.pending.push(record);
        break;
      }
      case "steer_task_request":
        state.consumed.add(id!);
        if (this.options.onSteerTask) {
          await this.invoke(() => this.options.onSteerTask!(record, workspace));
        }
        break;
      case "cancel_request":
        state.consumed.add(id!);
        await this.invoke(() => this.options.onCancel(record, workspace));
        break;
      case "browser_requested":
        state.consumed.add(id!);
        if (this.options.onStartBrowser) {
          await this.invoke(() => this.options.onStartBrowser!(record, workspace));
        }
        break;
      case "new_session_request":
        state.consumed.add(id!);
        if (this.options.onNewSession) {
          await this.invoke(() => this.options.onNewSession!(record, workspace));
        }
        break;
    }
  }

  private async invoke(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.report(error);
    }
  }

  private async invokeSpawn(workspace: string, record: SpawnRequest): Promise<"claimed" | "pending"> {
    try {
      return await this.options.onSpawn(record, workspace);
    } catch (error) {
      this.report(error);
      return "claimed";
    }
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt request processing.
    }
  }
}
