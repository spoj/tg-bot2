import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { EVENTS_FILE, TG_BOT_DIR, errorCode } from "./util.js";

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
    /** An inline-keyboard button press. `callback_query` is the raw Telegram CallbackQuery object (includes id, from, message, data, chat_instance). */
    type: "callback";
    callback_query: unknown;
  }
  | {
    /** A vote on a poll this bot sent. `poll_answer` is the raw Telegram PollAnswer object (poll_id, user, option_ids). */
    type: "poll_answer";
    poll_answer: unknown;
  }
  | {
    /** Confirmation of one outbox request. Host-side protocol fields, not a Telegram object. */
    type: "send";
    kind: string;
    id: string;
    messageId?: number | undefined;
    pollId?: string | undefined;
    ok: boolean;
    error?: string | undefined;
  };

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Appends chat events to the workspace events log. Opens the events file once and
 * writes one `{v:1,t:...}` line per event, in order. Best-effort: never rejects and
 * never follows a symbolic link planted at the events directory or file.
 */
export async function appendChatEvents(workspace: string, events: ChatEvent[]): Promise<void> {
  try {
    const directory = path.join(workspace, TG_BOT_DIR);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) throw new Error(`Chat events directory must not be a symbolic link: ${directory}`);
    if (!stat.isDirectory()) throw new Error(`Chat events directory is not a directory: ${directory}`);

    const filePath = path.join(directory, EVENTS_FILE);
    const handle = await openEventsFile(filePath);
    try {
      for (const event of events) {
        const line = `${JSON.stringify({ v: 1, t: new Date().toISOString(), ...event })}\n`;
        await handle.write(line, null, "utf8");
      }
    } finally {
      await handle.close().catch(() => {});
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
    return await open(filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW, 0o600);
  } catch (error) {
    if (errorCode(error) !== "ELOOP") throw error;
    try {
      await unlink(filePath);
    } catch (unlinkError) {
      if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
    }
    return open(filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW, 0o600);
  }
}

/**
 * Renders the EVENTS protocol section of the SYSTEM_PROMPT: the shape of the
 * events.jsonl lines appended by {@link appendChatEvent}, derived from
 * {@link ChatEvent}.
 */
export function renderEventsPrompt(): string {
  return `Every chat event is appended by the host to /workspace/.tg-bot/events.jsonl (one JSON
object per line, newest last; every line starts with {v:1,t,...} where t is an ISO-8601
timestamp). Event types:
- message: {v:1,t,type:'message',message,attachments} where message is the raw Telegram
  Message object (message_id, date, from, chat, text, caption, location, venue, photo,
  document, reply_to_message, and any other Bot API Message field) and attachments lists
  files the host downloaded into /workspace/attachments/... for you
  ({type,path,mimeType,originalName} or {type,failure}).
- callback: {v:1,t,type:'callback',callback_query} where callback_query is the raw
  Telegram CallbackQuery object (id, from, message, data, chat_instance).
- poll_answer: {v:1,t,type:'poll_answer',poll_answer} where poll_answer is the raw
  Telegram PollAnswer object (poll_id, user, option_ids).
- send: a confirmation of one of your outbox requests:
  {v:1,t,type:'send',kind,id,messageId?,pollId?,ok,error?}.
Grep events.jsonl whenever you need recent chat history or sent message ids.
When a user message or button press arrives the host wakes you with a single "." prompt
that carries no content. Read the newest events.jsonl lines and decide whether the user
needs a response. Send ALL Telegram output through .tg-bot/outbox requests; never rely
on the wake prompt for content.
`;
}
