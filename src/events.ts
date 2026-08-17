import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

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

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * Appends one chat event to the workspace events log. Best-effort: never rejects and
 * never follows a symbolic link planted at the events directory or file.
 */
export function appendChatEvent(workspace: string, event: ChatEvent): Promise<void> {
  return (async () => {
    try {
      const directory = path.join(workspace, ".tg-bot");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (stat.isSymbolicLink()) throw new Error(`Chat events directory must not be a symbolic link: ${directory}`);
      if (!stat.isDirectory()) throw new Error(`Chat events directory is not a directory: ${directory}`);

      const filePath = path.join(directory, "events.jsonl");
      const line = `${JSON.stringify({ v: 1, t: new Date().toISOString(), ...event })}\n`;
      const handle = await openEventsFile(filePath);
      try {
        await handle.write(line, null, "utf8");
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (error) {
      console.error("Failed to append chat event", error);
    }
  })();
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
