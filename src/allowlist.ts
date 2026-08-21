import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorCode, TG_BOT_DIR } from "./util.js";

/**
 * Agent-owned allow list: `workspace/.tg-bot/allowed.json`, the single source of
 * truth for which chats the agent may talk to. The host only enforces it — it
 * writes nothing but the one-time bootstrap entry (and that only when the file
 * does not exist yet).
 */

export type AllowedChat = {
  chat_id: number;
  title?: string;
  added_by: "bootstrap" | "agent";
  added_at: string;
};

export type AllowedFile =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "ready"; chats: AllowedChat[] };

const ALLOWED_FILE = "allowed.json";

export function allowedFilePath(workspace: string): string {
  return path.join(workspace, TG_BOT_DIR, ALLOWED_FILE);
}

/** Reads the allow list. Missing and malformed files are distinct states: missing bootstraps, malformed fails closed. */
export async function readAllowedFile(workspace: string): Promise<AllowedFile> {
  let raw: string;
  try {
    raw = await readFile(allowedFilePath(workspace), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    console.error("Failed to read allowed.json", error);
    return { status: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error("Malformed allowed.json", error);
    return { status: "malformed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("Malformed allowed.json: root must be an object");
    return { status: "malformed" };
  }
  const chats = (parsed as Record<string, unknown>).chats;
  if (!Array.isArray(chats)) {
    console.error("Malformed allowed.json: chats must be an array");
    return { status: "malformed" };
  }
  const result: AllowedChat[] = [];
  for (const entry of chats) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      console.error("Malformed allowed.json: chat entries must be objects");
      return { status: "malformed" };
    }
    const chat = entry as Record<string, unknown>;
    if (typeof chat.chat_id !== "number" || !Number.isSafeInteger(chat.chat_id)) {
      console.error("Malformed allowed.json: chat_id must be a safe integer");
      return { status: "malformed" };
    }
    const title = typeof chat.title === "string" ? chat.title : undefined;
    const addedBy = chat.added_by === "bootstrap" ? "bootstrap" : "agent";
    const addedAt = typeof chat.added_at === "string" ? chat.added_at : "";
    result.push({ chat_id: chat.chat_id, ...(title === undefined ? {} : { title }), added_by: addedBy, added_at: addedAt });
  }
  return { status: "ready", chats: result };
}

/** One-time bootstrap: creates the file exclusively, so the first chatter wins a concurrent race. Resolves false when the file already exists. */
export async function bootstrapAllowedChat(workspace: string, entry: AllowedChat): Promise<boolean> {
  const directory = path.join(workspace, TG_BOT_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify({ version: 1, chats: [entry] }, null, 2)}\n`;
  try {
    await writeFile(allowedFilePath(workspace), content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    console.error("Failed to write allowed.json", error);
    return false;
  }
}
