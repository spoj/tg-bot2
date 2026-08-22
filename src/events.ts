import { mkdir } from "node:fs/promises";
import path from "node:path";
import { appendJsonl, readJsonl } from "./util.js";
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
    /** An edited user message. `chat_id` is the Telegram chat it arrived from; `message` is the raw Telegram Message object; `attachments` are files the host downloaded into the workspace. */
    type: "edited_message";
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
    /** A reaction change on a message. `chat_id` is the Telegram chat it arrived from; `message_reaction` is the raw Telegram MessageReactionUpdated object. */
    type: "message_reaction";
    chat_id: number;
    message_reaction: unknown;
  }
  | {
    /** The bot's chat member status/permission changed. `chat_id` is the Telegram chat; `my_chat_member` is the raw Telegram ChatMemberUpdated object. */
    type: "my_chat_member";
    chat_id: number;
    my_chat_member: unknown;
  }
  | {
    /** A user requested to join a chat where the bot has administrator rights. `chat_id` is the Telegram chat; `chat_join_request` is the raw Telegram ChatJoinRequest object. */
    type: "chat_join_request";
    chat_id: number;
    chat_join_request: unknown;
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
    origin?: string | undefined;
    prompt?: string | undefined;
    status: "done" | "failed" | "aborted";
    exitCode: number | null;
    stderr?: string | undefined;
  }
  | {
    /** Periodic progress checkpoint for active background tasks. */
    type: "task_progress";
    origin?: string | undefined;
    tasks: Array<{
      runId: string;
      prompt: string;
      runningMs: number;
      idleMs: number | null;
      lastOutput?: string | undefined;
    }>;
  }
  | {
    /** Telegram accepted one send_request; `requestId` matches the request's UUID; `data` is the raw Telegram response payload. */
    type: "outbox_sent";
    requestId: string;
    origin?: string | undefined;
    chat_id: number;
    message_thread_id?: number | undefined;
    messageId?: number | undefined;
    pollId?: string | undefined;
    request_type?: string | undefined;
    summary?: string | undefined;
    data?: unknown;
  }
  | {
    /** A rejected send_request. `requestId` matches the request's UUID; `detail` describes the failure. */
    type: "outbox_rejected";
    requestId: string;
    origin?: string | undefined;
    chat_id?: number | undefined;
    message_thread_id?: number | undefined;
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
    origin?: string | undefined;
    status: "started" | "existing";
    socketPath: string;
    wsEndpoint: string;
  }
  | {
    /** Host failed to launch Chrome (binary missing, spawn error, socket error, etc.). */
    type: "browser_request_failed";
    requestId: string;
    origin?: string | undefined;
    error: string;
  }
  | {
    /** Browser instance terminated and UNIX socket was cleaned up. */
    type: "browser_closed";
    reason: "idle_timeout" | "agent_close" | "process_exit" | "host_shutdown";
  };

/** All entries recorded in the host-owned append-only events log. */
export type BotEvent = HostEvent;

/** Envelope added to every JSON line in the host-owned events log. */
export type LogEntryEnvelope = {
  v: 1;
  t: string;
};

/** Full serialized record shape in the host-owned events log. */
export type WorkspaceLogRecord<T = BotEvent> = LogEntryEnvelope & T;
export const EVENTS_FILE = "events.jsonl";

export type EventListener = (record: WorkspaceLogRecord, rawLine: string) => void | Promise<void>;

/**
 * Durable, host-owned append-only event log with in-memory live pub/sub.
 * The file lives outside the agent workspace; the agent only reads it through
 * a read-only bind mount. Agents never write it — commands arrive via the host bridge.
 */
export class WorkspaceEventLog {
  private readonly listeners = new Set<EventListener>();

  constructor(
    readonly logPath: string,
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
   * Appends an event to the events log atomically and broadcasts it to in-memory
   * subscribers. Resolves to the serialized line, or undefined when the append
   * failed — in which case listeners are NOT notified, so an in-memory terminal
   * outcome can never outlive a failed persistence.
   */
  async publish(event: BotEvent): Promise<string | undefined> {
    const lines = await appendEvents(this.logPath, [event]);
    if (lines === undefined) return undefined;
    const line = lines[0] as string;
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
    return line;
  }

  /** Emits an event (alias for publish). */
  async emit(event: BotEvent): Promise<string | undefined> {
    return this.publish(event);
  }

  /** Reads all parsed log records from the events log. Read failures are logged, never silently treated as an empty log. */
  async readAll(): Promise<WorkspaceLogRecord[]> {
    let lines: string[];
    try {
      lines = await readJsonl(this.logPath);
    } catch (error) {
      this.logger(error);
      return [];
    }
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
  }

  /**
   * Scans the events log in reverse order (newest first) to find the first record matching predicate.
   */
  async findLast<T extends BotEvent = BotEvent>(
    predicate: (record: WorkspaceLogRecord) => boolean,
  ): Promise<WorkspaceLogRecord<T> | undefined> {
    let lines: string[];
    try {
      lines = await readJsonl(this.logPath);
    } catch (error) {
      this.logger(error);
      return undefined;
    }
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
    return undefined;
  }
}
/**
 * Appends events to the host-owned events log with O_APPEND so concurrent
 * writes never corrupt lines. The log lives outside the agent workspace.
 */
export async function appendEvents(logPath: string, events: BotEvent[]): Promise<string[] | undefined> {
  try {
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const lines = events.map(eventLine);
    await appendJsonl(logPath, lines);
    return lines;
  } catch (error) {
    console.error("Failed to append event lines to events.jsonl", error);
    return undefined;
  }
}

/** Appends one event; see {@link appendEvents}. Resolves to the written line, or undefined when the append failed. */
export async function appendEvent(logPath: string, event: BotEvent): Promise<string | undefined> {
  return (await appendEvents(logPath, [event]))?.[0];
}

/** Serializes one event to the exact jsonl line form written by {@link appendEvent}: `{v:1, t:"<ISO-8601>", ...event}`. */
export function eventLine(event: object): string {
  return JSON.stringify({ v: 1, t: new Date().toISOString(), ...event });
}

/** The EVENTS protocol section of the SYSTEM_PROMPT, derived from {@link BotEvent}. */
export const EVENTS_PROMPT = `Timeline log /workspace/.tg-bot/events.jsonl is a host-owned, read-only record of inbound wire events and host outcomes in timestamp order ({v:1,t,type,...}).
Your tool calls (send, spawn, steer_task, cancel, start_browser) execute synchronously against the host and are not logged as commands — only their outcomes appear here.
Inbound wire events:
- message: {type:'message',chat_id,message,attachments} (raw Telegram Message; attachments in /workspace/attachments/<chat_id>/...)
- edited_message: {type:'edited_message',chat_id,message,attachments} (edited Telegram Message; attachments in /workspace/attachments/<chat_id>/...)
- callback: {type:'callback',chat_id,callback_query} (button press CallbackQuery)
- poll_answer: {type:'poll_answer',chat_id,poll_answer} (non-anonymous poll vote)
- message_reaction: {type:'message_reaction',chat_id,message_reaction} (reaction change on message)
- my_chat_member: {type:'my_chat_member',chat_id,my_chat_member} (bot membership/permission change in chat)
- chat_join_request: {type:'chat_join_request',chat_id,chat_join_request} (user join request to chat)
Host outcomes:
- outbox_sent / outbox_rejected: records send delivery; outbox_sent echoes messageId/pollId.
- task_settled: {type:'task_settled',runId,prompt?,status,exitCode,stderr?} when a background task finishes (done, failed, aborted).
- task_progress: periodic status checkpoint for active background tasks.
- schedule_run_scheduled / schedule_run_fired / schedule_run_cancelled: schedule occurrence lifecycle.
- allowlist_updated: updated allowed chat IDs.
- chat_denied: inbound message dropped from unallowed chat.
- browser_ready / browser_request_failed / browser_closed: CDP browser lifecycle.
When messages arrive from allowed chats, the host interrupts you with the raw event JSON lines.
`;
