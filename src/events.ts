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
    /** A user message (text, media, location, venue, …). `message` is the raw Telegram Message object; `attachments` are files the host downloaded into the workspace. */
    type: "message";
    message: unknown;
    attachments: Array<{ type: string; path?: string | undefined; mimeType?: string | undefined; originalName?: string | undefined; failure?: string | undefined }>;
  }
  | {
    /** An inline-keyboard button press. `callback_query` is the raw Telegram CallbackQuery object (id, from, message, chat_instance). `data` is optional — game buttons carry `game_short_name` instead; logged callbacks are message-backed. */
    type: "callback";
    callback_query: unknown;
  }
  | {
    /** A vote on a poll this bot sent. `poll_answer` is the raw Telegram PollAnswer object (poll_id, user, option_ids). */
    type: "poll_answer";
    poll_answer: unknown;
  }
  | {
    /** Confirmation that one send call reached Telegram. `requestId` is the host-assigned UUID; `data` carries the response payload where applicable. Host-side protocol fields, not a Telegram object. */
    type: "send";
    kind: string;
    requestId: string;
    messageId?: number | undefined;
    pollId?: string | undefined;
    data?: unknown;
  };

/**
 * One host-system event, appended to `.tg-bot/system.jsonl` in the same
 * `{v:1,t:...}` envelope: background task settlements and outbox rejections
 * that never appear in the Telegram chat window.
 */
export type SystemEvent =
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
  }
  | {
    /** Telegram accepted one send_request; `requestId` matches the request's UUID; `data` is the raw Telegram response payload. */
    type: "outbox_sent";
    requestId: string;
    messageId?: number | undefined;
    pollId?: string | undefined;
    data?: unknown;
  }
  | {
    /** A rejected send_request. `requestId` matches the request's UUID; `detail` describes the failure. */
    type: "outbox_rejected";
    requestId: string;
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
 * follows a symbolic link planted at the log directory or file.
 */
export async function appendChatEvents(workspace: string, events: ChatEvent[]): Promise<void> {
  await appendLines(workspace, CHAT_FILE, "chat event", events);
}

/** Appends one chat event; see {@link appendChatEvents}. */
export function appendChatEvent(workspace: string, event: ChatEvent): Promise<void> {
  return appendChatEvents(workspace, [event]);
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
): Promise<void> {
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
      const records = events.map((event) => JSON.stringify({ v: 1, t: new Date().toISOString(), ...event }));
      await appendJsonl(targetFile, records);
    } finally {
      await pinned.handle.close().catch(() => {});
    }
  } catch (error) {
    console.error(`Failed to append ${label}${events.length === 1 ? "" : "s"}`, error);
  }
}

/** The EVENTS protocol section of the SYSTEM_PROMPT, derived from {@link ChatEvent} and {@link SystemEvent}. */
export const EVENTS_PROMPT = `Two append-only logs live under /workspace/.tg-bot/ (one JSON object per line, newest
last; every line starts with {v:1,t,...} where t is an ISO-8601 timestamp).
chat.jsonl mirrors the Telegram chat window. Event types:
- message: {v:1,t,type:'message',message,attachments} where message is the raw Telegram
  Message object (message_id, date, from, chat, text, caption, location, venue, photo,
  document, reply_to_message, and any other Bot API Message field) and attachments lists
  files the host downloaded into /workspace/attachments/... for you
  ({type,path,mimeType,originalName} or {type,failure}).
- callback: {v:1,t,type:'callback',callback_query} where callback_query is the raw
  Telegram CallbackQuery object (id, from, message, chat_instance). data is optional and
  may instead be game_short_name; logged callbacks are message-backed.
- poll_answer: {v:1,t,type:'poll_answer',poll_answer} where poll_answer is the raw
  Telegram PollAnswer object (poll_id, user, option_ids).
- send: a confirmation of one of your send commands that Telegram accepted:
  {v:1,t,type:'send',kind,requestId,messageId?,pollId?,data?} where requestId is the
  UUID the send tool returned to you and data carries the Telegram response object the
  request produced (for stop_poll it is the final closed Poll).
system.jsonl is the shared command-and-outcome log: your host tools append one command
line per request, and the host appends the outcome lines.
Commands (written by your tools; the host processes each exactly once):
- send_request: {v:1,t,type:'send_request',requestId,request} queued by the send tool;
  requestId is the UUID the tool returns to you and request is your request object.
- spawn_request: {v:1,t,type:'spawn_request',runId,prompt} queued by the spawn tool;
  runId is the UUID the tool returns to you.
- cancel_request: {v:1,t,type:'cancel_request',runId} queued by the cancel tool.
Outcomes (host-written):
- outbox_claimed: {v:1,t,type:'outbox_claimed',requestId} when the host starts a send.
- outbox_sent: {v:1,t,type:'outbox_sent',requestId,messageId?,pollId?,data?} when
  Telegram accepts it, whether or not it returned a message id; data is the raw
  Telegram response payload.
- outbox_rejected: {v:1,t,type:'outbox_rejected',requestId,detail} reports a rejected
  send; detail describes the failure.
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
When a user message or button press arrives, the host interrupts you with a single "."
prompt that carries no content; read the newest chat.jsonl lines and decide whether the
user needs a response. Task settlements and send rejections arrive as followup
messages describing what happened. Send ALL Telegram output through the send tool;
never rely on wake prompts for content.
`;
