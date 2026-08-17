import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type ChatEvent =
  | { type: "message"; messageId: number; text?: string | undefined; attachments?: Array<{ type: string; path?: string | undefined; mimeType?: string | undefined; originalName?: string | undefined; failure?: string | undefined }> }
  | { type: "callback"; messageId: number; data: string }
  | { type: "poll_answer"; messageId: number; pollId: string; optionIds: number[] }
  | { type: "send"; kind: string; id: string; messageId?: number; pollId?: string; ok: boolean; error?: string };

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * Appends one chat event to the workspace events log. Best-effort: never throws and
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
      const line = `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`;
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
