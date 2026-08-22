import { mkdir } from "node:fs/promises";
import path from "node:path";
import { appendJsonl, closeQuietly, isMissing, openPinnedDirectory, readJsonl, type PinnedDirectory, TG_BOT_DIR } from "./util.js";
import type { Recurrence } from "./schedule-protocol.js";

/**
 * Inbound events and host outcomes in the unified append-only `.tg-bot/events.jsonl` log.
 */
export type HostEvent =
  | {
    /** A user message (text, media, location, venue, …). `chat_id` is the Telegram chat it arrived from; `message` is the raw Telegram Message object; `attachments` are files the host downloaded into the workspace. */
    type: "message";
    chat_id: number;
    message: unknown;
    attachments: Array<{ type: string; path?: string | undefined; mimeType?: string | undefined; originalName?: string | undefined; failure?: string | undefined }>;
  }
  | {
    /** An inline-keyboard button press. `chat_id` is the chat the button's message lives in; `callback_query` is the raw Telegram CallbackQuery object (id, from, message, chat_instance). `data` is optional — game buttons carry `game_short_name` instead; logged callbacks are message-backed. */
    type: "callback";
    chat_id: number;
    callback_query: unknown;
  }
  | {
    /** A vote on a poll this bot sent. `chat_id` is the chat the poll lives in; `poll_answer` is the raw Telegram PollAnswer object (poll_id, user, option_ids). */
    type: "poll_answer";
    chat_id: number;
    poll_answer: unknown;
  }
  | {
    /** The allow list of chat IDs was updated or detected on change. `chats` is the complete sorted list of allowed chat IDs. */
    type: "allowlist_updated";
    chats: number[];
  }
  | {
    /** A message, button press, or vote arrived from a chat the allow list does not include; the host dropped it without waking the agent. */
    type: "chat_denied";
    chat_id: number;
    title?: string | undefined;
  }
  | {
    /** A background task settled. The run's files live under /workspace/.pi/tasks/<runId>/. */
    type: "task_settled";
    runId: string;
    prompt?: string | undefined;
    status: "done" | "failed" | "aborted";
    exitCode: number | null;
    stderr?: string | undefined;
  }
  | {
    /** Telegram accepted one send_request; `requestId` matches the request's UUID; `data` is the raw Telegram response payload. */
    type: "outbox_sent";
    requestId: string;
    chat_id: number;
    messageId?: number | undefined;
    pollId?: string | undefined;
    data?: unknown;
  }
  | {
    /** A rejected send_request. `requestId` matches the request's UUID; `detail` describes the failure. */
    type: "outbox_rejected";
    requestId: string;
    chat_id?: number | undefined;
    detail: string;
  }
  | {
    /** Host materialized one occurrence of a schedules.json row. `runId` is the host-assigned UUID; prompt/start/recurrence are the row snapshot; `dueAt` is this occurrence's firing time. */
    type: "schedule_run_scheduled";
    runId: string;
    prompt: string;
    start: string;
    recurrence: Recurrence | null;
    dueAt: string;
  }
  | {
    /** A scheduled occurrence ran. `runId` matches its schedule_run_scheduled event. */
    type: "schedule_run_fired";
    runId: string;
    prompt: string;
  }
  | {
    /** A scheduled occurrence was retired because its row vanished or changed in schedules.json. */
    type: "schedule_run_cancelled";
    runId: string;
  }
  | {
    /** Browser instance is running and accepting CDP connections on the UNIX socket. */
    type: "browser_ready";
    requestId?: string | undefined;
    status: "started" | "existing";
    socketPath: string;
    wsEndpoint: string;
  }
  | {
    /** Host failed to launch Chrome (binary missing, spawn error, socket error, etc.). */
    type: "browser_request_failed";
    requestId: string;
    error: string;
  }
  | {
    /** Browser instance terminated and UNIX socket was cleaned up. */
    type: "browser_closed";
    reason: "idle_timeout" | "agent_close" | "process_exit" | "host_shutdown";
  };

/**
 * Commands written by agent tools to the unified append-only `.tg-bot/events.jsonl` log.
 */
export type AgentCommand =
  | {
    /** Queued by the send tool; requestId is the tool-minted UUID. */
    type: "send_request";
    requestId: string;
    request: unknown;
  }
  | {
    /** Queued by the spawn tool; runId is the tool-minted UUID. */
    type: "spawn_request";
    runId: string;
    prompt: string;
  }
  | {
    /** Queued by the steer_task tool; steerId is the tool-minted UUID. */
    type: "steer_task_request";
    steerId: string;
    runId: string;
    message: string;
  }
  | {
    /** Queued by the cancel tool; runId is the target task run ID. */
    type: "cancel_request";
    runId: string;
  }
  | {
    /** Queued by the start_browser tool; requestId is the tool-minted UUID. */
    type: "browser_requested";
    requestId: string;
  };

/** All entries recorded in the unified append-only `.tg-bot/events.jsonl` log. */
export type BotEvent = HostEvent | AgentCommand;

/** Envelope added to every JSON line in `.tg-bot/events.jsonl`. */
export type LogEntryEnvelope = {
  v: 1;
  t: string;
};

/** Full serialized record shape in `.tg-bot/events.jsonl`. */
export type WorkspaceLogRecord<T = BotEvent> = LogEntryEnvelope & T;
export const EVENTS_FILE = "events.jsonl";

export type EventListener = (record: WorkspaceLogRecord, rawLine: string) => void | Promise<void>;

/**
 * Durable, file-backed workspace event log and in-memory live pub/sub stream.
 * Abstracts away .tg-bot/events.jsonl persistence, atomic append, and log querying.
 */
export class WorkspaceEventLog {
  private readonly listeners = new Set<EventListener>();

  constructor(
    readonly workspace: string,
    private readonly logger: (error: unknown) => void = (error) => console.error("WorkspaceEventLog error", error),
  ) {}

  /** Subscribes an in-memory listener to live published events. Returns an unsubscribe callback. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Appends an event to the unified workspace events.jsonl log atomically and broadcasts
   * it to in-memory subscribers. Resolves to the serialized line or undefined on write failure.
   */
  async publish(event: BotEvent): Promise<string | undefined> {
    const lines = await appendEvents(this.workspace, [event]);
    const line = lines?.[0] ?? eventLine(event);
    let record: WorkspaceLogRecord;
    try {
      record = JSON.parse(line) as WorkspaceLogRecord;
    } catch {
      record = { v: 1, t: new Date().toISOString(), ...event } as WorkspaceLogRecord;
    }
    for (const listener of this.listeners) {
      try {
        const res = listener(record, line);
        if (res && typeof res.catch === "function") {
          res.catch((error) => this.logger(error));
        }
      } catch (error) {
        this.logger(error);
      }
    }
    return lines?.[0];
  }

  /** Emits an event (alias for publish). */
  async emit(event: BotEvent): Promise<string | undefined> {
    return this.publish(event);
  }

  /** Reads all parsed log records from events.jsonl. */
  async readAll(): Promise<WorkspaceLogRecord[]> {
    try {
      const lines = await readJsonl(path.join(this.workspace, TG_BOT_DIR, EVENTS_FILE));
      const records: WorkspaceLogRecord[] = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as WorkspaceLogRecord;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            records.push(parsed);
          }
        } catch {
          continue;
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  /**
   * Scans events.jsonl in reverse order (newest first) to find the first record matching predicate.
   */
  async findLast<T extends BotEvent = BotEvent>(
    predicate: (record: WorkspaceLogRecord) => boolean,
  ): Promise<WorkspaceLogRecord<T> | undefined> {
    try {
      const lines = await readJsonl(path.join(this.workspace, TG_BOT_DIR, EVENTS_FILE));
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as WorkspaceLogRecord;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && predicate(parsed)) {
            return parsed as unknown as WorkspaceLogRecord<T>;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // File missing or unreadable
    }
    return undefined;
  }
}


/**
 * Appends events to the unified workspace event log. Opens the `.tg-bot` directory
 * with `O_NOFOLLOW` and writes with `O_APPEND` so concurrent writes never corrupt
 * lines and symlink replacements are rejected.
 */
export async function appendEvents(workspace: string, events: BotEvent[]): Promise<string[] | undefined> {
  const directoryPath = path.join(workspace, TG_BOT_DIR);
  let metadata: PinnedDirectory | undefined;
  try {
    metadata = await openPinnedDirectory(directoryPath);
  } catch (error) {
    if (!isMissing(error)) {
      console.error("Pinned metadata directory open failed for events", error);
      return undefined;
    }
    try {
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      metadata = await openPinnedDirectory(directoryPath);
    } catch (mkdirError) {
      console.error("Metadata directory creation failed for events", mkdirError);
      return undefined;
    }
  }

  const lines = events.map(eventLine);
  const target = path.join(metadata.path, EVENTS_FILE);
  try {
    await appendJsonl(target, lines.join("\n"));
    return lines;
  } catch (error) {
    console.error("Failed to append event lines to events.jsonl", error);
    return undefined;
  } finally {
    if (metadata) await closeQuietly(metadata.handle);
  }
}

/** Appends one event; see {@link appendEvents}. Resolves to the written line, or undefined when the append failed. */
export async function appendEvent(workspace: string, event: BotEvent): Promise<string | undefined> {
  return (await appendEvents(workspace, [event]))?.[0];
}

/** Serializes one event to the exact jsonl line form written by {@link appendEvent}: `{v:1, t:"<ISO-8601>", ...event}`. */
export function eventLine(event: object): string {
  return JSON.stringify({ v: 1, t: new Date().toISOString(), ...event });
}

/** The EVENTS protocol section of the SYSTEM_PROMPT, derived from {@link BotEvent}. */
export const EVENTS_PROMPT = `You serve multiple Telegram chats. One append-only log lives under /workspace/.tg-bot/events.jsonl
(one JSON object per line, newest last; every line starts with {v:1,t,...} where t is
an ISO-8601 timestamp). It is the single timeline of everything: inbound Telegram wire events,
your host commands, and host outcome events.
Inbound wire events:
- message: {v:1,t,type:'message',chat_id,message,attachments} where message is the raw
  Telegram Message object (message_id, date, from, chat, text, caption, location, venue,
  photo, document, reply_to_message, and any other Bot API Message field) and
  attachments lists files the host downloaded into
  /workspace/attachments/<chat_id>/... for you ({type,path,mimeType,originalName} or
  {type,failure}).
- callback: {v:1,t,type:'callback',chat_id,callback_query} where callback_query is the
  raw Telegram CallbackQuery object (id, from, message, chat_instance). data is
  optional and may instead be game_short_name; logged callbacks are message-backed.
- poll_answer: {v:1,t,type:'poll_answer',chat_id,poll_answer} where poll_answer is the
  raw Telegram PollAnswer object (poll_id, user, option_ids).
Commands (written by your tools to the same events.jsonl log; the host processes each exactly once):
- send_request: {v:1,t,type:'send_request',requestId,request} queued by the send tool;
  requestId is the UUID the tool returns to you and request is your request object
  (including its chat_id).
- spawn_request: {v:1,t,type:'spawn_request',runId,prompt} queued by the spawn tool;
  runId is the UUID the tool returns to you.
- steer_task_request: {v:1,t,type:'steer_task_request',steerId,runId,message} queued by the steer_task tool.
- cancel_request: {v:1,t,type:'cancel_request',runId} queued by the cancel tool.
- browser_requested: {v:1,t,type:'browser_requested',requestId} queued by the start_browser tool.
Outcomes (host-written, exactly one terminal event per command):
- outbox_sent: {v:1,t,type:'outbox_sent',requestId,chat_id,messageId?,pollId?,data?}
  when Telegram accepts it, whether or not it returned a message id; data is the raw
  Telegram response payload (for stop_poll it is the final closed Poll).
- outbox_rejected: {v:1,t,type:'outbox_rejected',requestId,chat_id?,detail} reports a
  rejected send; detail describes the failure.
- task_settled: {v:1,t,type:'task_settled',runId,prompt?,status,exitCode,stderr?} when a
  task finishes: status is done, failed, or aborted (aborted means the run was killed
  via the cancel tool or the host restarted mid-run); stderr carries a bounded failure
  tail when failed. Run files live under /workspace/.pi/tasks/<runId>/.
- schedule_run_scheduled: {v:1,t,type:'schedule_run_scheduled',runId,prompt,start,recurrence,dueAt}
  when the host materializes one occurrence of a schedules.json row; runId is the
  host-assigned UUID, prompt/start/recurrence are the row snapshot, dueAt this firing time.
- schedule_run_fired: {v:1,t,type:'schedule_run_fired',runId,prompt} when that occurrence ran.
- schedule_run_cancelled: {v:1,t,type:'schedule_run_cancelled',runId} when its row was
  removed or edited before it fired.
- allowlist_updated: {v:1,t,type:'allowlist_updated',chats:[...]} when the host
  detects a change to allowed.json, recording the full sorted list of active chat IDs.
- chat_denied: {v:1,t,type:'chat_denied',chat_id,title?} when a message, button press,
  or poll vote arrived from a chat your allow list does not include; the host dropped
  it without interrupting you. Read these to decide whether to allow a chat.
- browser_ready: {v:1,t,type:'browser_ready',requestId?,status,socketPath,wsEndpoint} when
  Chrome is running and accepting CDP WebSocket connections on the UNIX domain socket.
- browser_request_failed: {v:1,t,type:'browser_request_failed',requestId,error} when
  the host fails to launch Chrome.
- browser_closed: {v:1,t,type:'browser_closed',reason} when Chrome exits (idle_timeout,
  agent_close, process_exit, host_shutdown).
Every send_request is followed by exactly one outbox_sent or outbox_rejected; every
spawn_request (and cancel) by exactly one task_settled. Grep events.jsonl for chat
history, commands, and host activity.
When a user message or button press arrives from an allowed chat, the host interrupts
you with the exact JSON line it just appended to events.jsonl for that event
({v:1,t,type,...}); events arriving close together are batched, and you receive one
combined message holding each of their lines. The full objects are there, nothing is
summarized. Decide whether that chat needs a response, and answer with the send tool
using its chat_id.
Task settlements and send rejections arrive as followup messages describing what
happened, batched into one combined message delivered after your turn. Send ALL
Telegram output through the send tool.
`;
