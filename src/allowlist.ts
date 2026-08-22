import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { errorCode, readFileBounded, TG_BOT_DIR } from "./util.js";
import { EVENTS_FILE, WorkspaceEventLog } from "./events.js";
/**
 * Agent-owned allow list: `workspace/.tg-bot/allowed.json`, containing an array of safe integer chat IDs.
 * The host enforces it both ways and emits `allowlist_updated` whenever changes are detected.
 */
export type AllowedFile =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "ready"; chats: number[] };

const ALLOWED_FILE = "allowed.json";
const ALLOWED_FILE_MAX_BYTES = 1024 * 1024;

export function allowedFilePath(workspace: string): string {
  return path.join(workspace, TG_BOT_DIR, ALLOWED_FILE);
}

/**
 * Reads the allow list. Missing and malformed files are distinct states (both fail closed).
 * The file is opened O_NOFOLLOW|O_NONBLOCK and must be a regular file of at most 1 MiB,
 * so a symlink, FIFO, or oversized file fails closed as malformed instead of blocking
 * or following an agent-controlled redirect.
 */
export async function readAllowedFile(workspace: string): Promise<AllowedFile> {
  const filePath = allowedFilePath(workspace);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    console.error("Failed to read allowed.json", error);
    return { status: "malformed" };
  }
  let raw: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      console.error("Malformed allowed.json: not a regular file");
      return { status: "malformed" };
    }
    if (stat.size > ALLOWED_FILE_MAX_BYTES) {
      console.error(`Malformed allowed.json: exceeds ${ALLOWED_FILE_MAX_BYTES} bytes`);
      return { status: "malformed" };
    }
    raw = (await readFileBounded(handle, ALLOWED_FILE_MAX_BYTES)).toString("utf8");
  } catch (error) {
    console.error("Failed to read allowed.json", error);
    return { status: "malformed" };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error("Malformed allowed.json", error);
    return { status: "malformed" };
  }

  let rawList: unknown[];
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).chats)) {
    rawList = (parsed as Record<string, unknown>).chats as unknown[];
  } else {
    console.error("Malformed allowed.json: root must be an array of chat IDs or object with chats array");
    return { status: "malformed" };
  }

  const ids: number[] = [];
  for (const item of rawList) {
    let id: unknown = item;
    if (item !== null && typeof item === "object" && "chat_id" in item) {
      id = (item as Record<string, unknown>).chat_id;
    }
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      console.error("Malformed allowed.json: chat IDs must be safe integers");
      return { status: "malformed" };
    }
    ids.push(id);
  }

  const uniqueSorted = Array.from(new Set(ids)).sort((a, b) => a - b);
  return { status: "ready", chats: uniqueSorted };
}

const lastEmittedAllowlists = new Map<string, string>();

/** Clears the cached allowlist state for testing. */
export function resetAllowlistCache(workspace?: string): void {
  if (workspace) lastEmittedAllowlists.delete(workspace);
  else lastEmittedAllowlists.clear();
}

async function lastLoggedAllowlist(eventLog: WorkspaceEventLog): Promise<string | undefined> {
  const record = await eventLog.findLast((entry) => entry.type === "allowlist_updated" && "chats" in entry && Array.isArray(entry.chats));
  if (record && record.type === "allowlist_updated") {
    return JSON.stringify(record.chats);
  }
  return undefined;
}

/**
 * Synchronizes the allow list: reads `allowed.json`, compares against the in-memory cache
 * (seeded once from `events.jsonl` on first check after boot), and emits `allowlist_updated` if changed.
 */
export async function syncAllowlist(workspace: string, events?: WorkspaceEventLog): Promise<number[] | null> {
  const file = await readAllowedFile(workspace);
  // Host state lives one level above the workspace (DATA_DIR/bots/<id>/events.jsonl).
  const eventLog = events ?? new WorkspaceEventLog(path.resolve(workspace, "..", EVENTS_FILE));
  if (!lastEmittedAllowlists.has(workspace)) {
    const logged = await lastLoggedAllowlist(eventLog);
    if (logged !== undefined) {
      lastEmittedAllowlists.set(workspace, logged);
    }
  }
  if (file.status !== "ready") {
    if (lastEmittedAllowlists.has(workspace)) {
      lastEmittedAllowlists.delete(workspace);
      await events?.emit({ type: "allowlist_updated", chats: [] });
    }
    return null;
  }

  const serialized = JSON.stringify(file.chats);
  const previous = lastEmittedAllowlists.get(workspace);
  if (previous !== serialized) {
    lastEmittedAllowlists.set(workspace, serialized);
    await events?.emit({ type: "allowlist_updated", chats: file.chats });
  }

  return file.chats;
}
