import { constants as fsConstants } from "node:fs";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { TG_BOT_DIR, errorCode, openPinnedDirectory, type PinnedDirectory } from "./util.js";

/**
 * One chat event, logged to `.tg-bot/events.jsonl` as one JSON line:
 * `{v:1, t:"<ISO-8601>", ...event}`. Inbound events carry Telegram's raw
 * objects verbatim (snake_case Bot API field names) so the log stays stable
 * and lossless as Telegram evolves; host-added fields are the `attachments`
 * array on message events and the outbox confirmation fields on send events.
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
    /** Confirmation that one outbox request reached Telegram. `id` is the request's filename without ".json"; `data` carries the response payload where applicable. Host-side protocol fields, not a Telegram object. */
    type: "send";
    kind: string;
    id: string;
    messageId?: number | undefined;
    pollId?: string | undefined;
    data?: unknown;
  }
  | {
    /** A rejected outbox request. `detail` describes the failure; the request body stays in outbox/failed/. */
    type: "outbox_rejected";
    detail: string;
  };

const EVENTS_FILE = "events.jsonl";
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const NON_BLOCKING = fsConstants.O_NONBLOCK;

/**
 * Appends chat events to the workspace events log. Opens the `.tg-bot` directory
 * pinned by an O_NOFOLLOW descriptor, then opens the events file once and writes one
 * `{v:1,t:...}` line per event, in order. Best-effort: never rejects and never follows
 * a symbolic link planted at the events directory or file.
 */
export async function appendChatEvents(workspace: string, events: ChatEvent[]): Promise<void> {
  try {
    const directory = path.join(workspace, TG_BOT_DIR);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const pinned = await openPinnedDirectory(directory);
    try {
      const handle = await openEventsFile(path.join(pinned.path, EVENTS_FILE));
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`Chat events file must be a regular file: ${EVENTS_FILE}`);
        for (const event of events) {
          const line = `${JSON.stringify({ v: 1, t: new Date().toISOString(), ...event })}\n`;
          await handle.write(line, null, "utf8");
        }
      } finally {
        await handle.close().catch(() => {});
      }
    } finally {
      await pinned.handle.close().catch(() => {});
    }
  } catch (error) {
    console.error(`Failed to append chat event${events.length === 1 ? "" : "s"}`, error);
  }
}

/**
 * Appends one chat event to the workspace events log. Best-effort: never rejects and
 * never follows a symbolic link planted at the events directory or file.
 */
export function appendChatEvent(workspace: string, event: ChatEvent): Promise<void> {
  return appendChatEvents(workspace, [event]);
}

/** Opens the events file, replacing a symlink the workspace may have planted at its path. */
async function openEventsFile(filePath: string): Promise<FileHandle> {
  try {
    return await open(filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW | NON_BLOCKING, 0o600);
  } catch (error) {
    if (errorCode(error) !== "ELOOP") throw error;
    try {
      await unlink(filePath);
    } catch (unlinkError) {
      if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
    }
    return open(filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW | NON_BLOCKING, 0o600);
  }
}

/** The EVENTS protocol section of the SYSTEM_PROMPT, derived from {@link ChatEvent}. */
export const EVENTS_PROMPT = `Every chat event is appended by the host to /workspace/.tg-bot/events.jsonl (one JSON
object per line, newest last; every line starts with {v:1,t,...} where t is an ISO-8601
timestamp). Event types:
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
  {v:1,t,type:'send',kind,id,messageId?,pollId?,data?} where id is your request's
  filename without ".json" and data carries the Telegram
  response object the request produced (for stop_poll it is the final closed Poll).
- outbox_rejected: {v:1,t,type:'outbox_rejected',detail} reports a rejected request; the
  rejection is recorded in .tg-bot/failed.jsonl ({id,request,error}) so you can inspect it.
Grep events.jsonl whenever you need recent chat history or sent message ids.
When a user message, button press, or outbox rejection arrives, the host wakes you with a
single "." prompt that carries no content. Read the newest events.jsonl lines and decide
whether the user needs a response. Send ALL Telegram output through .tg-bot/outbox requests;
never rely on the wake prompt for content.
`;
