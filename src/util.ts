import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** Strips keys whose value is undefined at runtime AND at the type level; preserves the presence/absence contract under exactOptionalPropertyTypes. */
export function defined<T extends object>(value: T): { [K in keyof T]-?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]-?: Exclude<T[K], undefined>;
  };
}

export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export async function closeQuietly(handle: { close(): Promise<void> }): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Suppress close errors
  }
}

const MAX_DIAGNOSTIC_LENGTH = 1_024;

export function errorMessage(error: unknown): string {
  let detail: string;
  try {
    detail = error instanceof Error ? error.message : String(error);
  } catch {
    detail = "unknown error";
  }
  return detail.length > MAX_DIAGNOSTIC_LENGTH ? `${detail.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : detail;
}

/**
 * Resolves a canonical directory, rejecting symlinks and path swaps.
 * Returns the canonical path. `expectedRealPath` is an optional caller-known canonical the result must equal.
 */
export async function requireRealDirectory(candidate: string, label: string, expectedRealPath?: string): Promise<string> {
  const initial = await lstat(candidate);
  if (!initial.isDirectory()) {
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

/** Derives canonical directories for one bot: `DATA_DIR/bots/<botId>` and its persistent workspace. */
export function botPaths(dataDir: string, botId: number): { botDir: string; workspace: string } {
  if (!Number.isSafeInteger(botId)) throw new Error("Telegram bot ID must be a safe integer");
  const botDir = path.join(dataDir, "bots", String(botId));
  return {
    botDir,
    workspace: path.join(botDir, "workspace"),
  };
}

export type PinnedDirectory = {
  handle: FileHandle;
  path: string;
  realPath: string;
};

/**
 * Opens a directory directly with O_NOFOLLOW, pinning the inode so later path
 * swaps cannot redirect the handle. The fd realpath is the canonical path.
 */
export async function openPinnedDirectory(directory: string, expectedRealPath?: string): Promise<PinnedDirectory> {
  const handle = await open(directory, fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory()) throw new Error(`Directory changed while opening: ${directory}`);
    const fdPath = `/proc/self/fd/${handle.fd}`;
    const realPath = await realpath(fdPath);
    if (expectedRealPath !== undefined && realPath !== expectedRealPath) {
      throw new Error(`Directory is not stable: ${directory}`);
    }
    return { handle, path: fdPath, realPath };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

const DIRECTORY = fsConstants.O_DIRECTORY;
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const NON_BLOCKING = fsConstants.O_NONBLOCK;

/**
 * Appends one or more serialized records to a JSONL store (filePath). A symlink planted
 * at the path is unlinked and the open retried (ELOOP defense).
 */
export async function appendJsonl(
  filePath: string,
  recordOrRecords: string | string[],
): Promise<void> {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
  if (records.length === 0) return;
  const payload = Buffer.from(records.map((r) => `${r}\n`).join(""), "utf8");
  const handle = await openJsonlAppend(filePath);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("JSONL store is not a regular file");
    await handle.write(payload, 0, payload.length, null);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Reads every line of a JSONL store (filePath), dropping a possible partial first
 * line, without following symlinks.
 */
export async function readJsonl(
  filePath: string,
): Promise<string[]> {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("JSONL store is not a regular file");
    return await readJsonlLines(handle, stat.size);
  } finally {
    await handle.close().catch(() => {});
  }
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

/** Reads every line of a store, dropping a possible partial final line. */
async function readJsonlLines(handle: FileHandle, size: number): Promise<string[]> {
  const buffer = Buffer.allocUnsafe(size);
  let bytesRead = 0;
  while (bytesRead < size) {
    const result = await handle.read(buffer, bytesRead, size - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead).toString("utf8").split("\n").filter(Boolean);
}
