import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
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


export type WorkspacePaths = {
  root: string;
  workspace: string;
  attachments: string;
  timeline: string;
  notifications: string;
  schedules: string;
  resources: string;
  runDir: string;
  connectorsDir: string;
};

export function workspacePaths(dataDir: string, workspaceId: string): WorkspacePaths {
  if (!/^[A-Za-z0-9._-]+$/u.test(workspaceId)) throw new Error("Workspace ID contains unsupported characters");
  const root = path.join(dataDir, "workspaces", workspaceId);
  const runDir = path.join(root, "run");
  return {
    root,
    workspace: path.join(root, "workspace"),
    attachments: path.join(root, "attachments"),
    timeline: path.join(root, "timeline.jsonl"),
    notifications: path.join(root, "notifications.jsonl"),
    schedules: path.join(runDir, "schedules.json"),
    resources: path.join(runDir, "resources.json"),
    runDir,
    connectorsDir: path.join(root, "connectors"),
  };
}

export function connectorPathSegment(connectorId: string): string {
  return Buffer.from(connectorId).toString("base64url");
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
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW | NON_BLOCKING;
const FILE_OPEN_FLAGS = fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING;

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
 * Reads a regular file without following symlinks in any path component,
 * blocking on a special file, or retaining more than capBytes of input.
 */
export async function readRegularFileBounded(filePath: string, capBytes: number): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const finalComponent = components.pop();
  if (finalComponent === undefined) throw new Error("File is not a regular file");

  const directories: FileHandle[] = [];
  try {
    let directory = await open(parsed.root, DIRECTORY_OPEN_FLAGS);
    directories.push(directory);
    for (const component of components) {
      const child = await open(path.join(`/proc/self/fd/${directory.fd}`, component), DIRECTORY_OPEN_FLAGS);
      try {
        const stat = await child.stat();
        if (!stat.isDirectory()) throw new Error(`Path component is not a directory: ${component}`);
      } catch (error) {
        await child.close().catch(() => {});
        throw error;
      }
      directories.push(child);
      directory = child;
    }

    const handle = await open(path.join(`/proc/self/fd/${directory.fd}`, finalComponent), FILE_OPEN_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("File is not a regular file");
      if (stat.size > capBytes) throw new Error(`File exceeds ${capBytes} byte cap`);
      return await readFileBounded(handle, capBytes);
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    for (let index = directories.length - 1; index >= 0; index--) {
      await directories[index]!.close().catch(() => {});
    }
  }
}

/** Replaces a file by writing a same-directory temporary file and renaming it. */
export async function replaceFileAtomic(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}


/**
 * Appends serialized records to a JSONL store (filePath), creating and validating the store even when the array is empty. A symlink planted
 * at the path is unlinked and the open retried (ELOOP defense). Writes loop until the
 * whole payload is on disk; zero write progress throws instead of reporting success
 * with a partial record.
 */
export async function appendJsonl(
  filePath: string,
  recordOrRecords: string | string[],
): Promise<void> {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
  const payload = Buffer.from(records.map((r) => `${r}\n`).join(""), "utf8");
  const handle = await openJsonlAppend(filePath);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("JSONL store is not a regular file");
    const completeTail = await discardUnterminatedTail(handle, stat.size);
    if (completeTail && payload.length > 0) {
      const separator = Buffer.from("\n", "utf8");
      let separatorWritten = 0;
      while (separatorWritten < separator.length) {
        const result = await handle.write(separator, separatorWritten, separator.length - separatorWritten, null);
        if (result.bytesWritten === 0) {
          throw new Error(`JSONL store accepted only ${separatorWritten} of ${separator.length} bytes`);
        }
        separatorWritten += result.bytesWritten;
      }
    }
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
 * Reads every complete line of a JSONL store (filePath), retaining a final
 * syntactically complete record even when it has no trailing newline. Only a
 * malformed unterminated final fragment is dropped, without following symlinks.
 */
export async function readJsonl(
  filePath: string,
): Promise<string[]> {
  const handle = await open(filePath, FILE_OPEN_FLAGS);
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

/** Returns true for a valid final record, or truncates a malformed tail. */
async function discardUnterminatedTail(handle: FileHandle, size: number): Promise<boolean> {
  if (size > JSONL_READ_CAP_BYTES) throw new Error(`File exceeds ${JSONL_READ_CAP_BYTES} byte cap`);
  if (size === 0) return false;
  let end = size;
  let tailStart = 0;
  while (end > 0) {
    const start = Math.max(0, end - READ_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(end - start);
    const result = await handle.read(chunk, 0, chunk.length, start);
    if (result.bytesRead !== chunk.length) throw new Error("JSONL store changed while checking its final line");
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) {
      tailStart = start + newline + 1;
      break;
    }
    end = start;
  }
  if (tailStart === size) return false;

  const tail = Buffer.allocUnsafe(size - tailStart);
  const result = await handle.read(tail, 0, tail.length, tailStart);
  if (result.bytesRead !== tail.length) throw new Error("JSONL store changed while checking its final line");
  if (isSyntacticallyCompleteJson(tail)) return true;
  await handle.truncate(tailStart);
  return false;
}

/** Reads every complete line of a store in bounded chunks, dropping a malformed unterminated final fragment. */
async function readJsonlLines(handle: FileHandle): Promise<string[]> {
  const contents = await readFileBounded(handle, JSONL_READ_CAP_BYTES);
  const finalNewline = contents.lastIndexOf(0x0a);
  if (finalNewline < 0) {
    const finalRecord = contents.toString("utf8");
    return isSyntacticallyCompleteJson(contents) ? [finalRecord] : [];
  }
  const lines = contents.subarray(0, finalNewline).toString("utf8").split("\n").filter(Boolean);
  const finalFragment = contents.subarray(finalNewline + 1);
  if (finalFragment.length > 0 && isSyntacticallyCompleteJson(finalFragment)) lines.push(finalFragment.toString("utf8"));
  return lines;
}

function isSyntacticallyCompleteJson(value: Buffer): boolean {
  try {
    JSON.parse(value.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}
