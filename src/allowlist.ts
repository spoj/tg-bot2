import { readFile } from "node:fs/promises";
import path from "node:path";
import { errorCode, TG_BOT_DIR } from "./util.js";
import type { EventSink } from "./events.js";

/**
 * Agent-owned allow list: `workspace/.tg-bot/allowed.json`, containing an array of safe integer chat IDs.
 * The host enforces it both ways and emits `allowlist_updated` whenever changes are detected.
 */
export type AllowedFile =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "ready"; chats: number[] };

const ALLOWED_FILE = "allowed.json";

export function allowedFilePath(workspace: string): string {
  return path.join(workspace, TG_BOT_DIR, ALLOWED_FILE);
}

/** Reads the allow list. Missing and malformed files are distinct states (both fail closed). */
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

/**
 * Synchronizes the allow list: reads `allowed.json`, compares against the last emitted
 * state for this workspace, and emits `allowlist_updated` if changed.
 */
export async function syncAllowlist(workspace: string, events?: EventSink): Promise<number[] | null> {
  const file = await readAllowedFile(workspace);
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
