import { mkdir } from "node:fs/promises";
import path from "node:path";
import { appendJsonl, TG_BOT_DIR, errorCode, openPinnedDirectory } from "./util.js";
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
    /** Confirmation that one outbox request reached Telegram. `requestId` is the host-assigned UUID; `name` is the original request filename; `data` carries the response payload where applicable. Host-side protocol fields, not a Telegram object. */
    type: "send";
    kind: string;
    requestId: string;
    name: string;
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
    /** Host claimed one task file. `name` is the agent's original filename; `runId` identifies /workspace/.pi/tasks/<runId>/. */
    type: "task_claimed";
    name: string;
    runId: string;
  }
  | {
    /** A background task settled. `name` is the prompt filename the agent wrote; the run's files live under /workspace/.pi/tasks/<runId>/. */
    type: "task_settled";
    name: string;
    runId: string;
    status: "done" | "failed" | "aborted";
    exitCode: number | null;
    stderr?: string | undefined;
  }
  | {
    /** Host claimed one outbox request file; `requestId` is the host-assigned UUID; `name` is the original request filename; `request` is the full validated request. */
    type: "outbox_claimed";
    requestId: string;
    name: string;
    request: unknown;
  }
  | {
    /** Telegram accepted one outbox request; `requestId` is the host-assigned UUID; `name` is the original request filename; `request` is the full request and `data` the raw Telegram response payload. */
    type: "outbox_sent";
    requestId: string;
    name: string;
    request: unknown;
    messageId?: number | undefined;
    pollId?: string | undefined;
    data?: unknown;
  }
  | {
    /** A rejected outbox request. `requestId` is the host-assigned UUID; `name` is the original request filename; `detail` describes the failure; `request` is the validated request when parsing succeeded, otherwise `raw` is the file's original text. */
    type: "outbox_rejected";
    requestId: string;
    name: string;
    detail: string;
    request?: unknown;
    raw?: string | undefined;
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
export const EVENTS_PROMPT = `The host appends two logs under /workspace/.tg-bot/ (one JSON object per line, newest
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
- send: a confirmation of one of your outbox requests that Telegram accepted:
  {v:1,t,type:'send',kind,requestId,name,messageId?,pollId?,data?} where requestId is the
  host-assigned UUID, name is your original request filename, and data carries the
  Telegram response object the request produced (for stop_poll it is the final closed Poll).
system.jsonl records host activity that never appears in the chat window:
- task_claimed: {v:1,t,type:'task_claimed',name,runId} when the host claims one of your
  task files; runId identifies the run directory /workspace/.pi/tasks/<runId>/.
- task_settled: {v:1,t,type:'task_settled',name,runId,status,exitCode,stderr?} when a
  task finishes: status is done, failed, or aborted (aborted means the run was killed
  or the host restarted mid-run); stderr carries a bounded failure tail when failed.
- outbox_claimed: {v:1,t,type:'outbox_claimed',requestId,name,request} when the host claims
  one of your outbox request files; requestId is the host-assigned UUID, name is your
  original request filename, and request is the full validated request.
- outbox_sent: {v:1,t,type:'outbox_sent',requestId,name,request,messageId?,pollId?,data?}
  when Telegram accepts a request, whether or not it returned a message id; request is
  the full request and data is the raw Telegram response payload.
- outbox_rejected: {v:1,t,type:'outbox_rejected',requestId,name,detail,request?,raw?}
  reports a rejected request; requestId is the host-assigned UUID, name is your original
  request filename, request is the validated request when parsing succeeded, otherwise
  raw is the file's original text.
- schedule_run_scheduled: {v:1,t,type:'schedule_run_scheduled',runId,prompt,start,recurrence,dueAt}
  when the host materializes one occurrence of a schedules.json row; runId is the
  host-assigned UUID, prompt/start/recurrence are the row snapshot, dueAt this firing time.
- schedule_run_fired: {v:1,t,type:'schedule_run_fired',runId} when that occurrence ran.
- schedule_run_cancelled: {v:1,t,type:'schedule_run_cancelled',runId} when its row was
  removed or edited before it fired.
Every claimed task is followed by exactly one task_settled; every claimed outbox request
is followed by exactly one outbox_sent or outbox_rejected; every schedule_run_scheduled is
followed by exactly one schedule_run_fired or schedule_run_cancelled. Grep chat.jsonl for
chat history and system.jsonl for host activity.
When a user message or button press arrives, the host interrupts you with a single "."
prompt that carries no content; read the newest chat.jsonl lines and decide whether the
user needs a response. Task settlements and outbox rejections arrive as followup
messages describing what happened. Send ALL Telegram output through .tg-bot/outbox
requests; never rely on wake prompts for content.
`;
