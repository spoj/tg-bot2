import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { FileHandle, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** Strips keys whose value is undefined at runtime AND at the type level; preserves the presence/absence contract under exactOptionalPropertyTypes. */
export function defined<T extends object>(value: T): { [K in keyof T]-?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]-?: Exclude<T[K], undefined>;
  };
}

/** Reads the string `code` property off an unknown error, or undefined. */
export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Resolves a canonical directory, rejecting symlinks and path swaps.
 * Returns the canonical path. `expectedRealPath` is an optional caller-known canonical the result must equal.
 */
export async function requireRealDirectory(candidate: string, label: string, expectedRealPath?: string): Promise<string> {
  const initial = await lstat(candidate);
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${candidate}`);
  }
  const canonical = await realpath(candidate);
  if (expectedRealPath !== undefined && canonical !== expectedRealPath) {
    throw new Error(`${label} is not stable: ${candidate}`);
  }
  const canonicalStat = await lstat(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${candidate}`);
  }
  return canonical;
}

export const TG_BOT_DIR = ".tg-bot";
export const OUTBOX_DIR = "outbox";
export const EVENTS_FILE = "events.jsonl";
export const SCHEDULES_FILE = "schedules.json";
export const POLL_RESULTS_FILE = "poll-results.jsonl";
export const ATTACHMENTS_DIR = "attachments";

export function canonicalChatId(chatId: number): string {
  if (!Number.isSafeInteger(chatId)) throw new Error("Telegram chat ID must be a safe integer");
  return String(chatId);
}

export function chatPaths(dataDir: string, chatId: number): { workspace: string } {
  return { workspace: path.join(dataDir, "chats", canonicalChatId(chatId), "workspace") };
}

const CHAT_DIRECTORY = /^-?(?:0|[1-9]\d*)$/u;

/** Maps a numeric directory name to a chat ID, rejecting leading zeros, non-numbers, and unsafe integers. */
export function numericChatId(name: string): number | undefined {
  if (!CHAT_DIRECTORY.test(name)) return undefined;
  const chatId = Number(name);
  if (!Number.isSafeInteger(chatId) || String(chatId) !== name) return undefined;
  return chatId;
}

export type PinnedDirectory = {
  handle: FileHandle;
  path: string;
  realPath: string;
};

/**
 * Opens a real directory pinned by an O_NOFOLLOW file descriptor, verifying the
 * directory did not change (dev/ino) or get swapped (fd realpath) during opening.
 */
export async function openPinnedDirectory(directory: string, expectedRealPath?: string): Promise<PinnedDirectory> {
  const canonical = await requireRealDirectory(directory, "Directory", expectedRealPath);
  const canonicalStat = await lstat(canonical);
  const handle = await open(canonical, fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isDirectory() ||
      openedStat.isSymbolicLink() ||
      openedStat.dev !== canonicalStat.dev ||
      openedStat.ino !== canonicalStat.ino
    ) {
      throw new Error(`Directory changed while opening: ${directory}`);
    }
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (openedPath !== canonical) throw new Error(`Directory is not stable: ${directory}`);
    return { handle, path: `/proc/self/fd/${handle.fd}`, realPath: canonical };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;

/**
 * Appends one record to a bounded line store (filePath), rotating to the last
 * `maxLines` lines when the line or byte caps are exceeded. A symlink planted at
 * the path is unlinked and the open retried (ELOOP defense).
 */
export async function appendBoundedJsonl(
  filePath: string,
  record: string,
  caps: { maxLines: number; maxBytes: number },
): Promise<void> {
  const line = `${record}\n`;
  const handle = await openJsonlAppend(filePath);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("JSONL store is not a regular file");
    await handle.write(line, null, "utf8");
    const total = stat.size + Buffer.byteLength(line, "utf8");
    const lines = await readJsonlLines(handle, total, caps.maxBytes);
    if (lines.length > caps.maxLines || total > caps.maxBytes) {
      await replaceJsonl(filePath, `${lines.slice(-caps.maxLines).join("\n")}\n`);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Reads the tail of a bounded line store (filePath), dropping a possible partial
 * first line, without following symlinks.
 */
export async function readBoundedJsonl(
  filePath: string,
  caps: { maxLines: number; maxBytes: number },
): Promise<string[]> {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("JSONL store is not a regular file");
    return await readJsonlLines(handle, stat.size, caps.maxBytes);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Resolves an awaited deferred operation that rejects when the timeout elapses. */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error | void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      let failure: unknown;
      try {
        failure = onTimeout();
      } catch (error) {
        failure = error;
      }
      reject(failure instanceof Error ? failure : new Error("Operation timed out"));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Opens a store file for appending, replacing a symlink planted at its path. */
async function openJsonlAppend(filePath: string): Promise<FileHandle> {
  try {
    return await open(filePath, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW | NON_BLOCKING, 0o600);
  } catch (error) {
    if (errorCode(error) !== "ELOOP") throw error;
    try {
      await unlink(filePath);
    } catch (unlinkError) {
      if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
    }
    return open(filePath, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW | NON_BLOCKING, 0o600);
  }
}

/** Reads the tail of a store, dropping a possible partial first line. */
async function readJsonlLines(handle: FileHandle, size: number, maxBytes: number): Promise<string[]> {
  const readLength = Math.min(size, maxBytes);
  const position = size - readLength;
  const buffer = Buffer.allocUnsafe(readLength);
  let bytesRead = 0;
  while (bytesRead < readLength) {
    const result = await handle.read(buffer, bytesRead, readLength - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
  const complete = position === 0 ? lines : lines.slice(1);
  return complete.filter(Boolean);
}

/** Atomically rewrites a store via a unique temporary file, retrying the temp name on collision. */
async function replaceJsonl(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tempPath = path.join(directory, `.jsonl-${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, 0o600);
      await handle.write(content, null, "utf8");
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    await rename(tempPath, filePath);
    return;
  }
  throw new Error("Unable to rewrite JSONL store");
}
