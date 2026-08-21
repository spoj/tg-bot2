import { mkdir } from "node:fs/promises";
import path from "node:path";
import { appendJsonl, errorCode, openPinnedDirectory, TG_BOT_DIR } from "./util.js";
import type { Recurrence } from "./schedule-protocol.js";

/**
 * One chat event, appended to `.tg-bot/chat.jsonl` — a faithful mirror of the
 * Telegram chat window — as one JSON line: `{v:1, t:"<ISO-8601>", ...event}`.
 * Inbound events carry Telegram's raw objects verbatim (snake_case Bot API field
 * names) so the log stays stable and lossless as Telegram evolves; host-added
 * fields are the `attachments` array on message events and the outbox
 * confirmation fields on send events.
 */
export type ChatEvent =
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
    /** Confirmation that one send call reached Telegram. `chat_id` is the target chat; `requestId` is the host-assigned UUID; `data` carries the response payload where applicable. Host-side protocol fields, not a Telegram object. */
    type: "send";
    chat_id: number;
    kind: string;
    requestId: string;
    messageId?: number | undefined;
    pollId?: string | undefined;
    data?: unknown;
  };

/**
 * One host-system event, appended to `.tg-bot/system.jsonl` in the same
 * `{v:1,t:...}` envelope: allow-list gates, background task settlements, and
 * outbox outcomes that never appear in the Telegram chat window.
 */
export type SystemEvent =
  | {
    /** Host bootstrapped or accepted one chat into the allow list (bootstrap is the first-ever chatter; agent edits are not logged here). */
    type: "chat_allowed";
    chat_id: number;
    title?: string | undefined;
    added_by: "bootstrap";
    added_at: string;
  }
  | {
    /** A message, button press, or vote arrived from a chat the allow list does not include; the host dropped it without waking the agent. */
    type: "chat_denied";
    chat_id: number;
    title?: string | undefined;
  }
  | {
    /** Host started processing one spawn_request. `runId` matches the request's UUID; the run's files live under /workspace/.pi/tasks/<runId>/. */
    type: "task_claimed";
    runId: string;
  }
  | {
    /** A background task settled. The run's files live under /workspace/.pi/tasks/<runId>/. */
    type: "task_settled";
    runId: string;
    status: "done" | "failed" | "aborted";
    exitCode: number | null;
    stderr?: string | undefined;
  }
  | {
    /** The agent asked to stop one running task; the settle that follows lands as aborted. */
    type: "task_cancelled";
    runId: string;
  }
  | {
    /** Host started processing one send_request; `requestId` matches the request's UUID. */
    type: "outbox_claimed";
    requestId: string;
    chat_id: number;
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
  }
  | {
    /** A scheduled occurrence was retired because its row vanished or changed in schedules.json. */
    type: "schedule_run_cancelled";
    runId: string;
  };

const CHAT_FILE = "chat.jsonl";
const SYSTEM_FILE = "system.jsonl";
/**
 * Appends chat events to the workspace chat log. Opens the `.tg-bot` directory
 * pinned by an O_NOFOLLOW descriptor, then opens the log file once and writes one
 * `{v:1,t:...}` line per event, in order. Best-effort: never rejects and never
 * follows a symbolic link planted at the log directory or file. Resolves to the
 * written lines, or undefined when the append failed.
 */
export async function appendChatEvents(workspace: string, events: ChatEvent[]): Promise<string[] | undefined> {
  return await appendLines(workspace, CHAT_FILE, "chat event", events);
}

/** Appends one chat event; see {@link appendChatEvents}. Resolves to the written line, or undefined when the append failed. */
export async function appendChatEvent(workspace: string, event: ChatEvent): Promise<string | undefined> {
  return (await appendChatEvents(workspace, [event]))?.[0];
}

/** Serializes one chat event to the exact jsonl line form written by {@link appendChatEvent}: `{v:1, t:"<ISO-8601>", ...event}`. */
export function chatEventLine(event: ChatEvent): string {
  return eventLine(event);
}

function eventLine(event: object): string {
  return JSON.stringify({ v: 1, t: new Date().toISOString(), ...event });
}

async function appendSystemEvents(workspace: string, events: SystemEvent[]): Promise<void> {
  await appendLines(workspace, SYSTEM_FILE, "system event", events);
}

/** Appends one system event; see {@link appendSystemEvents}. */
export function appendSystemEvent(workspace: string, event: SystemEvent): Promise<void> {
  return appendSystemEvents(workspace, [event]);
}

async function appendLines(
  workspace: string,
  fileName: string,
  label: string,
  events: Array<ChatEvent | SystemEvent>,
): Promise<string[] | undefined> {
  try {
    const directory = path.join(workspace, TG_BOT_DIR);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const pinned = await openPinnedDirectory(directory);
    try {
      const targetFile = path.join(pinned.path, fileName);
      const records = events.map(eventLine);
      await appendJsonl(targetFile, records);
      return records;
    } finally {
      await pinned.handle.close().catch(() => {});
    }
  } catch (error) {
    console.error(`Failed to append ${label}${events.length === 1 ? "" : "s"}`, error);
    return undefined;
  }
}

/** The EVENTS protocol section of the SYSTEM_PROMPT, derived from {@link ChatEvent} and {@link SystemEvent}. */
export const EVENTS_PROMPT = `You serve multiple Telegram chats. Two append-only logs live under /workspace/.tg-bot/
(one JSON object per line, newest last; every line starts with {v:1,t,...} where t is
an ISO-8601 timestamp). Every chat.jsonl event carries chat_id, the Telegram chat it
belongs to; reply to a chat with the send tool using its chat_id.
chat.jsonl mirrors every Telegram chat window you serve. Event types:
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
- send: a confirmation of one of your send commands that Telegram accepted:
  {v:1,t,type:'send',chat_id,kind,requestId,messageId?,pollId?,data?} where requestId is
  the UUID the send tool returned to you and data carries the Telegram response object
  the request produced (for stop_poll it is the final closed Poll).
system.jsonl is the shared command-and-outcome log: your host tools append one command
line per request, and the host appends the outcome lines.
Commands (written by your tools; the host processes each exactly once):
- send_request: {v:1,t,type:'send_request',requestId,request} queued by the send tool;
  requestId is the UUID the tool returns to you and request is your request object
  (including its chat_id).
- spawn_request: {v:1,t,type:'spawn_request',runId,prompt} queued by the spawn tool;
  runId is the UUID the tool returns to you.
- cancel_request: {v:1,t,type:'cancel_request',runId} queued by the cancel tool.
Outcomes (host-written):
- chat_allowed: {v:1,t,type:'chat_allowed',chat_id,title?,added_by,added_at} when the
  host bootstraps the very first chat that ever messaged you into the allow list.
- chat_denied: {v:1,t,type:'chat_denied',chat_id,title?} when a message, button press,
  or poll vote arrived from a chat your allow list does not include; the host dropped
  it without interrupting you. Read these to decide whether to allow a chat.
- outbox_claimed: {v:1,t,type:'outbox_claimed',requestId,chat_id} when the host starts
  a send.
- outbox_sent: {v:1,t,type:'outbox_sent',requestId,chat_id,messageId?,pollId?,data?}
  when Telegram accepts it, whether or not it returned a message id; data is the raw
  Telegram response payload.
- outbox_rejected: {v:1,t,type:'outbox_rejected',requestId,chat_id?,detail} reports a
  rejected send; detail describes the failure.
- task_claimed: {v:1,t,type:'task_claimed',runId} when the host starts a task run;
  the run's files live under /workspace/.pi/tasks/<runId>/ (prompt.txt, output.md,
  sessions/, result.json).
- task_settled: {v:1,t,type:'task_settled',runId,status,exitCode,stderr?} when a
  task finishes: status is done, failed, or aborted (aborted means the run was killed
  via the cancel tool or the host restarted mid-run); stderr carries a bounded failure
  tail when failed.
- task_cancelled: {v:1,t,type:'task_cancelled',runId} when you ask to stop one running
  task; the task_settled that follows lands as aborted.
- schedule_run_scheduled: {v:1,t,type:'schedule_run_scheduled',runId,prompt,start,recurrence,dueAt}
  when the host materializes one occurrence of a schedules.json row; runId is the
  host-assigned UUID, prompt/start/recurrence are the row snapshot, dueAt this firing time.
- schedule_run_fired: {v:1,t,type:'schedule_run_fired',runId} when that occurrence ran.
- schedule_run_cancelled: {v:1,t,type:'schedule_run_cancelled',runId} when its row was
  removed or edited before it fired.
Every send_request is followed by outbox_claimed then exactly one outbox_sent or
outbox_rejected; every spawn_request by task_claimed then exactly one task_settled;
every cancel_request by task_cancelled. Grep chat.jsonl for chat history and
system.jsonl for commands and host activity.
When a user message or button press arrives from an allowed chat, the host interrupts
you with the exact JSON line it just appended to chat.jsonl for that event
({v:1,t,type,...}); events arriving close together are batched, and you receive one
combined message holding each of their lines. The full objects are there, nothing is
summarized. Decide whether that chat needs a response, and answer with the send tool
using its chat_id.
Task settlements and send rejections arrive as followup messages describing what
happened, batched into one combined message delivered after your turn. Send ALL
Telegram output through the send tool.
`;
