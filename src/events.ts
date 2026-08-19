import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { TG_BOT_DIR, errorCode, openPinnedDirectory, type PinnedDirectory } from "./util.js";

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
    /** Confirmation that one outbox request reached Telegram. `id` is the request's filename without ".json"; `data` carries the response payload where applicable. Host-side protocol fields, not a Telegram object. */
    type: "send";
    kind: string;
    id: string;
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
    /** A background task settled. `name` is the prompt filename the agent wrote; the run's files live under /workspace/.pi/tasks/<runId>/. */
    type: "task";
    name: string;
    runId: string;
    status: "done" | "failed";
    exitCode: number | null;
    stderr?: string | undefined;
  }
  | {
    /** A rejected outbox request. `detail` describes the failure; the request body stays in outbox/failed/. */
    type: "outbox_rejected";
    detail: string;
  };

const CHAT_FILE = "chat.jsonl";
const SYSTEM_FILE = "system.jsonl";
const LEGACY_EVENTS_FILE = "events.jsonl";
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const NON_BLOCKING = fsConstants.O_NONBLOCK;

/**
 * Appends chat events to the workspace chat log. Opens the `.tg-bot` directory
 * pinned by an O_NOFOLLOW descriptor, then opens the log file once and writes one
 * `{v:1,t:...}` line per event, in order. Best-effort: never rejects and never
 * follows a symbolic link planted at the log directory or file.
 */
export async function appendChatEvents(workspace: string, events: ChatEvent[]): Promise<void> {
  await appendLines(workspace, CHAT_FILE, "chat event", events, true);
}

/** Appends one chat event; see {@link appendChatEvents}. */
export function appendChatEvent(workspace: string, event: ChatEvent): Promise<void> {
  return appendChatEvents(workspace, [event]);
}

/**
 * Appends host-system events to the workspace system log, in the same
 * best-effort pinned-descriptor manner as {@link appendChatEvents}.
 */
export async function appendSystemEvents(workspace: string, events: SystemEvent[]): Promise<void> {
  await appendLines(workspace, SYSTEM_FILE, "system event", events, false);
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
  migrateLegacy: boolean,
): Promise<void> {
  try {
    const directory = path.join(workspace, TG_BOT_DIR);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (migrateLegacy) await migrateLegacyEventsFile(directory);
    const pinned = await openPinnedDirectory(directory);
    try {
      const handle = await openLogFile(path.join(pinned.path, fileName));
      try {
        const logStat = await handle.stat();
        if (!logStat.isFile()) throw new Error(`${label} file must be a regular file: ${fileName}`);
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
    console.error(`Failed to append ${label}${events.length === 1 ? "" : "s"}`, error);
  }
}

/** Renames the pre-split events.jsonl to chat.jsonl once; never overwrites an existing chat log. */
async function migrateLegacyEventsFile(directory: string): Promise<void> {
  try {
    await stat(path.join(directory, CHAT_FILE));
    return;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    await rename(path.join(directory, LEGACY_EVENTS_FILE), path.join(directory, CHAT_FILE));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** Opens a log file, replacing a symlink the workspace may have planted at its path. */
async function openLogFile(filePath: string): Promise<FileHandle> {
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
  {v:1,t,type:'send',kind,id,messageId?,pollId?,data?} where id is your request's
  filename without ".json" and data carries the Telegram
  response object the request produced (for stop_poll it is the final closed Poll).
system.jsonl records host activity that never appears in the chat window:
- task: a background task settled: {v:1,t,type:'task',name,runId,status,exitCode,stderr?}
  where name is the prompt filename you wrote, runId identifies the run directory
  /workspace/.pi/tasks/<runId>/, status is done or failed, and stderr carries a bounded
  failure tail when failed.
- outbox_rejected: {v:1,t,type:'outbox_rejected',detail} reports a rejected request; the
  rejection is recorded in .tg-bot/failed.jsonl ({id,request,error}) so you can inspect it.
Grep chat.jsonl for chat history and system.jsonl for host activity.
When a user message or button press arrives, the host interrupts you with a single "."
prompt that carries no content; read the newest chat.jsonl lines and decide whether the
user needs a response. Task settlements and outbox rejections arrive as followup
messages describing what happened. Send ALL Telegram output through .tg-bot/outbox
requests; never rely on wake prompts for content.
`;
