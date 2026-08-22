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

/** Derives canonical directories for one bot: `DATA_DIR/bots/<botId>`, its persistent workspace, and host-owned state. */
export function botPaths(dataDir: string, botId: number): { botDir: string; workspace: string; eventsLog: string; runDir: string } {
  if (!Number.isSafeInteger(botId)) throw new Error("Telegram bot ID must be a safe integer");
  const botDir = path.join(dataDir, "bots", String(botId));
  return {
    botDir,
    workspace: path.join(botDir, "workspace"),
    eventsLog: path.join(botDir, "events.jsonl"),
    runDir: path.join(botDir, "run"),
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
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads a file handle to EOF in fixed-size chunks, never allocating more than
 * one chunk at a time. Throws once the total read exceeds `capBytes`, so an
 * oversized or growing store cannot OOM the host.
 */
export async function readFileBounded(handle: FileHandle, capBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const result = await handle.read(chunk, 0, chunk.length, null);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
    if (total > capBytes) throw new Error(`File exceeds ${capBytes} byte cap`);
    chunks.push(chunk.subarray(0, result.bytesRead));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Appends one or more serialized records to a JSONL store (filePath). A symlink planted
 * at the path is unlinked and the open retried (ELOOP defense). Writes loop until the
 * whole payload is on disk; zero write progress throws instead of reporting success
 * with a partial record.
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
    let written = 0;
    while (written < payload.length) {
      const result = await handle.write(payload, written, payload.length - written, null);
      if (result.bytesWritten === 0) {
        throw new Error(`JSONL store accepted only ${written} of ${payload.length} bytes`);
      }
      written += result.bytesWritten;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

const JSONL_READ_CAP_BYTES = 256 * 1024 * 1024;

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
    return await readJsonlLines(handle);
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

/** Reads every line of a store in bounded chunks, dropping a possible partial final line. */
async function readJsonlLines(handle: FileHandle): Promise<string[]> {
  const contents = await readFileBounded(handle, JSONL_READ_CAP_BYTES);
  return contents.toString("utf8").split("\n").filter(Boolean);
}

export type AgentOrigin =
  | { kind: "chat"; chatId: number; threadId: number }
  | { kind: "task"; runId: string };

export function parseOrigin(origin?: string): AgentOrigin | undefined {
  if (typeof origin !== "string" || !origin) return undefined;
  if (origin.startsWith("task:")) {
    const runId = origin.slice(5).trim();
    return runId ? { kind: "task", runId } : undefined;
  }
  const parts = origin.split(":");
  if (parts.length !== 2) return undefined;
  const chatId = Number(parts[0]);
  const threadId = Number(parts[1]);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId)) return undefined;
  return { kind: "chat", chatId, threadId };
}

export function formatOrigin(target: { chatId?: number; threadId?: number } | { runId: string }): string {
  if ("runId" in target && typeof target.runId === "string") {
    return `task:${target.runId}`;
  }
  const chatTarget = target as { chatId?: number; threadId?: number };
  if (typeof chatTarget.chatId === "number") {
    return `${chatTarget.chatId}:${chatTarget.threadId ?? 0}`;
  }
  return "default";
}
