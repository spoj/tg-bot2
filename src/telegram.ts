import { constants as fsConstants, type Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "./config.js";
import { WorkspaceTimeline } from "./events.js";
import { readAllowedFile } from "./allowlist.js";
import { SerialQueue } from "./queue.js";
import type { WorkspaceOutboxRequest, WorkspaceOutboxDispatchResult } from "./outbox-protocol.js";
import { WorkspaceResources } from "./resource-state.js";
import { telegramAddress, telegramConversation } from "./telegram-ref.js";
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;
const ATTACHMENT_RETRY_FALLBACK_MS = 100;
const MAX_ATTACHMENT_RETRY_AFTER_MS = 60_000;
const MAX_ATTACHMENT_ATTEMPTS = 3;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram Bot API download limit for incoming attachments (20 MiB).
const MAX_ATTACHMENT_STORAGE_BYTES = 50 * 1024 * 1024 * 1024;

const MAX_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024;
const OUTBOUND_READ_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const NON_BLOCKING = fsConstants.O_NONBLOCK;
const REJECTED_INGRESS_TTL_MS = 10 * 60 * 1_000;
const MAX_REJECTED_INGRESS = 1_024;

type AttachmentSource = {
  type: string;
  fileId: string;
  fileSize?: number | undefined;
  mimeType?: string | undefined;
  originalName?: string | undefined;
};

type SavedAttachment = {
  type: string;
  path?: string | undefined;
  mimeType?: string | undefined;
  originalName?: string | undefined;
  failure?: string | undefined;
};


export class TelegramDeliveryQueue {
  private readonly queues = new Map<number, SerialQueue>();

  enqueue<T>(chatId: number, operation: () => T | PromiseLike<T>): Promise<T> {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = new SerialQueue();
      this.queues.set(chatId, queue);
    }
    return queue.run(() => Promise.resolve(operation())).finally(() => {
      if (queue.size === 0 && this.queues.get(chatId) === queue) {
        this.queues.delete(chatId);
      }
    });
  }

  async drain(): Promise<void> {
    while (true) {
      const live = [...this.queues.values()];
      if (live.length === 0) return;
      await Promise.all(live.map((queue) => queue.idle()));
      await Promise.resolve();
    }
  }
}



const MEDIA_FIELDS: Partial<Record<WorkspaceOutboxRequest["method"], string>> = {
  sendPhoto: "photo", sendAudio: "audio", sendVideo: "video", sendAnimation: "animation",
  sendVoice: "voice", sendVideoNote: "video_note", sendDocument: "document",
};

function telegramPayload(request: WorkspaceOutboxRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...request };
  if (Array.isArray(payload.media)) payload.media = [...payload.media];
  delete payload.method;
  delete payload.topic_name;
  return payload;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function exposedCandidate(root: string, exposedPath: string, mountPoint: string): string {
  if (!exposedPath.startsWith(`${mountPoint}/`)) throw new Error(`Local file must be under ${mountPoint}/`);
  return path.resolve(root, exposedPath.slice(mountPoint.length + 1));
}

function localFileOpenError(error: unknown, mountPoint: string): Error {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ELOOP") return new Error(`Local file resolves outside ${mountPoint}`);
  if (code === "ENOTDIR") return new Error("Local path is not a regular file");
  if (code === "ENOENT") return new Error("Local file does not exist");
  return error instanceof Error ? error : new Error("Local file does not exist");
}

async function readPinnedFinalFile(
  fileHandle: Awaited<ReturnType<typeof open>>,
  expectedRoot: string,
  mountPoint: string,
): Promise<{ bytes: Buffer; resolved: string }> {
  const resolved = await realpath(`/proc/self/fd/${fileHandle.fd}`);
  if (!isWithinRoot(expectedRoot, resolved)) throw new Error(`Local file resolves outside ${mountPoint}`);
  const file = await fileHandle.stat();
  if (!file.isFile()) throw new Error("Local path is not a regular file");
  if (file.size > MAX_OUTBOUND_FILE_BYTES) throw new Error(`Local file exceeds ${MAX_OUTBOUND_FILE_BYTES} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_OUTBOUND_FILE_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(OUTBOUND_READ_CHUNK_BYTES, MAX_OUTBOUND_FILE_BYTES + 1 - total));
    const { bytesRead } = await fileHandle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_OUTBOUND_FILE_BYTES) throw new Error(`Local file exceeds ${MAX_OUTBOUND_FILE_BYTES} bytes`);
  return { bytes: Buffer.concat(chunks, total), resolved };
}

/**
 * Reads a local file through directory handles pinned one component at a time.
 * Checking realpath and then reopening the pathname would let an attacker swap
 * an intermediate directory between those operations.
 */
async function readLocalFile(root: string, exposedPath: string, mountPoint: string): Promise<{ bytes: Buffer; resolved: string }> {
  const expectedRoot = path.resolve(root);
  const candidate = exposedCandidate(expectedRoot, exposedPath, mountPoint);
  if (!isWithinRoot(expectedRoot, candidate)) throw new Error(`Local file escapes ${mountPoint}`);
  const relative = path.relative(expectedRoot, candidate);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let rootHandle: Awaited<ReturnType<typeof open>> | undefined;
  const directoryHandles: Array<Awaited<ReturnType<typeof open>>> = [];
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const rootRealPath = await realpath(expectedRoot).catch(() => { throw new Error("Local file does not exist"); });
    if (rootRealPath !== expectedRoot) throw new Error(`Local file resolves outside ${mountPoint}`);
    rootHandle = await open(expectedRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NO_FOLLOW);
    directoryHandles.push(rootHandle);
    const openedRoot = await realpath(`/proc/self/fd/${rootHandle.fd}`);
    if (openedRoot !== expectedRoot) throw new Error(`Local file resolves outside ${mountPoint}`);

    let parent = rootHandle;
    for (const segment of segments.slice(0, -1)) {
      const child = await open(`/proc/self/fd/${parent.fd}/${segment}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NO_FOLLOW);
      directoryHandles.push(child);
      parent = child;
    }
    if (segments.length > 0) {
      const name = segments[segments.length - 1]!;
      fileHandle = await open(`/proc/self/fd/${parent.fd}/${name}`, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
    } else {
      fileHandle = rootHandle;
    }
    if (!fileHandle) throw new Error("Local file does not exist");
    return await readPinnedFinalFile(fileHandle, expectedRoot, mountPoint);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("Local ") || error.message.startsWith("Directory "))) throw error;
    throw localFileOpenError(error, mountPoint);
  } finally {
    if (fileHandle && fileHandle !== rootHandle) await fileHandle.close().catch(() => {});
    for (const handle of [...directoryHandles].reverse()) await handle.close().catch(() => {});
  }
}

type StagedOutboundFile = {
  path: string;
  input: InputFile;
  cleanupPath?: string;
};

async function stageOutboundFile(
  paths: { workspace: string; attachments: string; attachmentPrefix: string }, chatId: number, requestId: string, exposedPath: string, index?: number,
): Promise<StagedOutboundFile> {
  const alreadyManaged = exposedPath.startsWith("/run/attachments/");
  const source = await readLocalFile(
    alreadyManaged ? paths.attachments : paths.workspace,
    exposedPath,
    alreadyManaged ? `/run/attachments/${paths.attachmentPrefix}` : "/workspace",
  );
  if (alreadyManaged) return { path: exposedPath, input: new InputFile(source.bytes, path.basename(source.resolved)) };
  if (source.bytes.length > MAX_ATTACHMENT_STORAGE_BYTES - await attachmentStorageBytes(attachmentWorkspaceRoot(paths.attachments))) {
    throw new Error("Attachment storage quota exceeded");
  }

  const date = new Date().toISOString().slice(0, 10);
  const directory = await ensureAttachmentDirectory(paths.attachments, chatId, date, requestId);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let cleanupPath: string | undefined;
  try {
    const base = safeFilename(path.basename(source.resolved), "file.bin");
    const filename = index === undefined ? base : `${index + 1}-${base}`;
    const destination = path.join(directory.path, filename);
    const candidateCleanupPath = path.resolve(paths.attachments, String(chatId), date, String(requestId), filename);
    try {
      handle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, 0o600);
      cleanupPath = candidateCleanupPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (handle) {
      const opened = handle;
      try {
        await opened.writeFile(source.bytes);
        await opened.close();
        handle = undefined;
      } catch (error) {
        await opened.close().catch(() => {});
        handle = undefined;
        await rm(destination, { force: true });
        throw error;
      }
    }
    await verifyAttachmentDirectory(directory);
    return {
      path: `/run/attachments/${paths.attachmentPrefix}/${chatId}/${date}/${requestId}/${filename}`,
      input: new InputFile(source.bytes, filename),
      ...(cleanupPath === undefined ? {} : { cleanupPath }),
    };
  } catch (error) {
    if (cleanupPath !== undefined) await rm(cleanupPath, { force: true });
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await directory.handle.close();
  }
}


async function removeStagedFiles(paths: readonly string[]): Promise<void> {
  const files = [...new Set(paths)];
  await Promise.all(files.map(async (filePath) => {
    await rm(filePath, { force: true });
  }));
  await Promise.all([...new Set(files.map((filePath) => path.dirname(filePath)))].map(async (directory) => {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }));
}

async function prepareTelegramPayload(
  paths: { workspace: string; attachments: string; attachmentPrefix: string }, chatId: number, requestId: string, request: WorkspaceOutboxRequest,
): Promise<{ payload: Record<string, unknown>; recorded: WorkspaceOutboxRequest; attachmentPaths: string[]; cleanupPaths: string[] }> {
  const payload = telegramPayload(request);
  const recorded = structuredClone(request);
  const attachmentPaths: string[] = [];
  const cleanupPaths: string[] = [];
  try {
    const field = MEDIA_FIELDS[request.method];
    if (field !== undefined && typeof payload[field] === "string" && (payload[field] as string).startsWith("/")) {
      const staged = await stageOutboundFile(paths, chatId, requestId, payload[field] as string);
      payload[field] = staged.input;
      recorded[field] = staged.path;
      attachmentPaths.push(staged.path);
      if (staged.cleanupPath !== undefined) cleanupPaths.push(staged.cleanupPath);
    }
    if (request.method === "sendMediaGroup" && Array.isArray(payload.media)) {
      const recordedMedia = recorded.media as Array<Record<string, unknown>>;
      const media = payload.media;
      for (let index = 0; index < media.length; index++) {
        const item = media[index];
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const copy = { ...(item as Record<string, unknown>) };
        if (typeof copy.media === "string" && copy.media.startsWith("/")) {
          const staged = await stageOutboundFile(paths, chatId, requestId, copy.media, index);
          copy.media = staged.input;
          recordedMedia[index] = { ...(recordedMedia[index] ?? {}), media: staged.path };
          attachmentPaths.push(staged.path);
          if (staged.cleanupPath !== undefined) cleanupPaths.push(staged.cleanupPath);
        }
        media[index] = copy;
      }
    }
    if (cleanupPaths.length > 0) await enforceAttachmentQuota(attachmentWorkspaceRoot(paths.attachments));
    return { payload, recorded, attachmentPaths, cleanupPaths };
  } catch (error) {
    await removeStagedFiles(cleanupPaths);
    throw error;
  }
}

export type TelegramDispatchResult = WorkspaceOutboxDispatchResult & {
  messageIds?: number[];
};

function dispatchResult(data: unknown, request: WorkspaceOutboxRequest, attachmentPaths: string[]): TelegramDispatchResult {
  const result = data !== null && typeof data === "object" ? data as Record<string, unknown> : {};
  const poll = result.poll !== null && typeof result.poll === "object" ? result.poll as Record<string, unknown> : undefined;
  const messageIds = request.method === "sendMediaGroup" && Array.isArray(data)
    ? data.flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const messageId = (item as Record<string, unknown>).message_id;
      return typeof messageId === "number" && Number.isSafeInteger(messageId) ? [messageId] : [];
    })
    : [];
  return {
    request,
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
    ...(messageIds.length > 0 ? { messageIds } : {}),
    ...(typeof result.message_id === "number" ? { messageId: result.message_id } : {}),
    ...(typeof poll?.id === "string" ? { pollId: poll.id } : {}),
    ...(typeof result.message_thread_id === "number" ? { messageThreadId: result.message_thread_id } : {}),
    data,
  };
}

export async function dispatchOutboxRequest(
  bot: Bot,
  paths: { workspace: string; attachments: string; attachmentPrefix: string },
  chatId: number,
  requestId: string,
  request: WorkspaceOutboxRequest,
): Promise<TelegramDispatchResult> {
  const raw = bot.api.raw as unknown as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;
  const call = raw[request.method];
  if (!call) throw new Error(`Telegram Bot API method is unavailable: ${request.method}`);
  const prepared = await prepareTelegramPayload(paths, chatId, requestId, request);
  try {
    const data = await call(prepared.payload);
    if (request.topic_name !== undefined && request.message_thread_id !== undefined) {
      try {
        await raw.editForumTopic?.({ chat_id: chatId, message_thread_id: request.message_thread_id, name: request.topic_name });
      } catch (error) {
        console.error("Incidental topic rename failed", error);
      }
    }
    return dispatchResult(data, prepared.recorded, prepared.attachmentPaths);
  } catch (error) {
    await removeStagedFiles(prepared.cleanupPaths);
    throw error;
  }
}
type AttachmentDirectory = {
  path: string;
  expectedPath: string;
  handle: Awaited<ReturnType<typeof open>>;
};


async function readAttachmentEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function attachmentWorkspaceRoot(connectorRoot: string): string {
  return path.resolve(connectorRoot, "..");
}


async function attachmentStorageBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readAttachmentEntries(directory)) {
    if (entry.isSymbolicLink()) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await attachmentStorageBytes(filePath);
      continue;
    }
    const stat = await lstat(filePath).catch(() => undefined);
    if (stat?.isFile()) total += stat.size;
  }
  return total;
}

async function enforceAttachmentQuota(rootPath: string): Promise<void> {
  if (await attachmentStorageBytes(path.resolve(rootPath)) > MAX_ATTACHMENT_STORAGE_BYTES) {
    throw new Error("Attachment storage quota exceeded");
  }
}

async function ensureAttachmentDirectory(rootPath: string, chatId: number, date: string, entryId: number | string): Promise<AttachmentDirectory> {
  const expectedRoot = path.resolve(rootPath);
  try {
    const entry = await lstat(expectedRoot);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Attachment root is not safe.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(expectedRoot, { recursive: true, mode: 0o700 });
  }
  const rootEntry = await lstat(expectedRoot).catch(() => undefined);
  if (!rootEntry || rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error("Attachment root is not safe.");
  const root = await realpath(expectedRoot);
  if (root !== expectedRoot) throw new Error("Attachment root is not safe.");
  let directory = root;
  for (const segment of [String(chatId), date, String(entryId)]) {
    directory = path.join(directory, segment);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Attachment directory is not safe.");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NO_FOLLOW);
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!isWithinRoot(root, openedPath)) throw new Error("Attachment directory is not safe.");
    return { path: `/proc/self/fd/${handle.fd}`, expectedPath: directory, handle };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function cancelAttachmentResponse(response: Response, controller: AbortController): Promise<void> {
  controller.abort();
  await response.body?.cancel().catch(() => {});
}

async function verifyAttachmentDirectory(directory: AttachmentDirectory): Promise<void> {
  const live = await lstat(directory.expectedPath);
  const pinned = await directory.handle.stat();
  if (!live.isDirectory() || live.dev !== pinned.dev || live.ino !== pinned.ino) {
    throw new AttachmentDownloadFailure("Telegram attachment download failed.");
  }
}

async function verifyExistingAttachment(directory: AttachmentDirectory, filename: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await verifyAttachmentDirectory(directory);
    try {
      handle = await open(path.join(directory.path, filename), fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const resolved = await realpath(`/proc/self/fd/${handle.fd}`);
    const pinned = await realpath(`/proc/self/fd/${directory.handle.fd}`);
    if (resolved !== path.join(pinned, filename) || !(await handle.stat()).isFile()) {
      throw new AttachmentDownloadFailure("Telegram attachment download failed.");
    }
    return true;
  } catch (error) {
    if (error instanceof AttachmentDownloadFailure) throw error;
    throw new AttachmentDownloadFailure("Telegram attachment download failed.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function safeFilename(name: string | undefined, fallback: string): string {
  const safeFallback = path.basename(fallback).replace(/^\.+/, "") || "file.bin";
  const base = path.basename(name?.trim() || safeFallback)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 48);
  return base || safeFallback;
}

type AttachmentSourceRow = {
  kind: string;
  pick: (message: Message) => Omit<AttachmentSource, "type"> | undefined;
};

const ATTACHMENT_SOURCES: readonly AttachmentSourceRow[] = [
  {
    kind: "animation",
    pick: (message) => {
      const animation = message.animation;
      if (!animation) return undefined;
      return { fileId: animation.file_id, fileSize: animation.file_size, mimeType: animation.mime_type, originalName: animation.file_name };
    },
  },
  {
    kind: "audio",
    pick: (message) => {
      const audio = message.audio;
      if (!audio) return undefined;
      return { fileId: audio.file_id, fileSize: audio.file_size, mimeType: audio.mime_type, originalName: audio.file_name };
    },
  },
  {
    kind: "document",
    pick: (message) => {
      const document = message.document;
      if (!document) return undefined;
      return { fileId: document.file_id, fileSize: document.file_size, mimeType: document.mime_type, originalName: document.file_name };
    },
  },
  {
    kind: "photo",
    pick: (message) => {
      const photo = message.photo?.at(-1);
      if (!photo) return undefined;
      return { fileId: photo.file_id, fileSize: photo.file_size, mimeType: "image/jpeg" };
    },
  },
  {
    kind: "sticker",
    pick: (message) => {
      const sticker = message.sticker;
      if (!sticker) return undefined;
      return { fileId: sticker.file_id, fileSize: sticker.file_size, mimeType: sticker.is_animated ? "application/x-tgsticker" : sticker.is_video ? "video/webm" : "image/webp" };
    },
  },
  {
    kind: "video",
    pick: (message) => {
      const video = message.video;
      if (!video) return undefined;
      return { fileId: video.file_id, fileSize: video.file_size, mimeType: video.mime_type, originalName: video.file_name };
    },
  },
  {
    kind: "video_note",
    pick: (message) => {
      const videoNote = message.video_note;
      if (!videoNote) return undefined;
      return { fileId: videoNote.file_id, fileSize: videoNote.file_size, mimeType: "video/mp4" };
    },
  },
  {
    kind: "voice",
    pick: (message) => {
      const voice = message.voice;
      if (!voice) return undefined;
      return { fileId: voice.file_id, fileSize: voice.file_size, mimeType: voice.mime_type };
    },
  },
];

export function attachmentSource(message: Message): AttachmentSource | undefined {
  for (const { kind, pick } of ATTACHMENT_SOURCES) {
    const source = pick(message);
    if (source) return { type: kind, ...source };
  }
  return undefined;
}

function attachmentEntryId(message: Message, source: AttachmentSource, edited: boolean): number | string {
  if (!edited) return message.message_id;
  const editDate = "edit_date" in message && typeof message.edit_date === "number" && Number.isSafeInteger(message.edit_date) && message.edit_date >= 0
    ? String(message.edit_date)
    : "unknown";
  const fileDigest = createHash("sha256").update(source.fileId).digest("hex").slice(0, 16);
  return `${message.message_id}-edit-${editDate}-${fileDigest}`;
}

function fallbackName(source: AttachmentSource, remotePath?: string): string {
  const remoteName = remotePath ? path.posix.basename(remotePath) : undefined;
  if (remoteName && path.posix.extname(remoteName) && !/^\.+$/.test(remoteName)) return remoteName;
  const extension: Record<string, string> = {
    animation: ".mp4", audio: ".audio", document: ".bin", photo: ".jpg", sticker: ".webp",
    video: ".mp4", video_note: ".mp4", voice: ".ogg",
  };
  return `${source.type}${extension[source.type] ?? ".bin"}`;
}

class AttachmentDownloadFailure extends Error {
  constructor(message = "Telegram attachment download failed", readonly status?: number) {
    super(message);
  }
}
class AttachmentQuotaFailure extends Error {}
class AttachmentRetryableFailure extends Error {
  constructor(readonly status?: number, readonly retryAfterMs?: number) {
    super("Telegram attachment download failed");
  }
}
class AttachmentStageFailure extends Error {
  constructor(readonly stage: string) {
    super(`Attachment ${stage} failed`);
  }
}

type GrammyAbortSignal = NonNullable<Parameters<Bot["api"]["getFile"]>[1]>;
type AttachmentAbortSignal = AbortSignal & GrammyAbortSignal;

function transientAttachmentStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function attachmentErrorClass(error: unknown): string {
  if (error instanceof GrammyError) return "GrammyError";
  if (error instanceof HttpError) return "HttpError";
  if (error instanceof AttachmentRetryableFailure) return "AttachmentRetryableFailure";
  if (error instanceof AttachmentDownloadFailure) return "AttachmentDownloadFailure";
  if (error instanceof AttachmentQuotaFailure) return "AttachmentQuotaFailure";
  return error instanceof Error ? "Error" : "UnknownError";
}

function attachmentHttpStatus(error: unknown): number | undefined {
  if (error instanceof AttachmentDownloadFailure || error instanceof AttachmentRetryableFailure) return error.status;
  if (error instanceof HttpError && error.error !== null && typeof error.error === "object" && "status" in error.error && typeof error.error.status === "number") {
    return error.error.status;
  }
  if (error instanceof Error || error === null || typeof error !== "object" || !("status" in error) || typeof error.status !== "number") return undefined;
  return error.status;
}

function attachmentErrorCode(error: unknown): number | string | undefined {
  if (error instanceof GrammyError) return error.error_code;
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "number" || (typeof code === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(code)) ? code : undefined;
}

function attachmentErrorMetadata(error: unknown): Record<string, number | string> {
  const metadata: Record<string, number | string> = { errorClass: attachmentErrorClass(error) };
  const errorCode = attachmentErrorCode(error);
  if (errorCode !== undefined) metadata.errorCode = errorCode;
  const httpStatus = attachmentHttpStatus(error);
  if (httpStatus !== undefined) metadata.httpStatus = httpStatus;
  return metadata;
}

function retryAfterMilliseconds(error: unknown): number {
  let requested: number | undefined;
  if (error instanceof GrammyError) {
    const retryAfter = error.parameters?.retry_after;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) requested = retryAfter * 1_000;
  } else if (error instanceof AttachmentRetryableFailure) {
    requested = error.retryAfterMs;
  }
  return Math.min(Math.max(requested ?? ATTACHMENT_RETRY_FALLBACK_MS, ATTACHMENT_RETRY_FALLBACK_MS), MAX_ATTACHMENT_RETRY_AFTER_MS);
}

function attachmentStageFailure(stage: string, error: unknown): AttachmentStageFailure {
  console.error("Telegram attachment download failed", { stage, ...attachmentErrorMetadata(error) });
  return new AttachmentStageFailure(stage);
}

function attachmentDate(message: Message): string {
  const timestamp = typeof message.date === "number" && Number.isFinite(message.date) ? message.date * 1_000 : NaN;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw attachmentStageFailure("message metadata", new AttachmentDownloadFailure("Invalid message date metadata."));
  return date.toISOString().slice(0, 10);
}

function retryAfterHeaderMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

async function retryAttachment<T>(
  stage: string,
  operation: (signal: AttachmentAbortSignal) => Promise<T>,
): Promise<{ value: T; controller: AbortController }> {
  for (let attempt = 1; attempt <= MAX_ATTACHMENT_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    try {
      const value = await attachmentTimeout(operation(controller.signal as AttachmentAbortSignal), controller);
      return { value, controller };
    } catch (error) {
      if (error instanceof AttachmentQuotaFailure) throw error;
      if (error instanceof AttachmentDownloadFailure) {
        if (error.status === undefined) throw error;
        throw attachmentStageFailure(stage, error);
      }
      const status = error instanceof GrammyError
        ? error.error_code
        : error instanceof AttachmentRetryableFailure
          ? error.status
          : error !== null && typeof error === "object" && "status" in error && typeof error.status === "number"
            ? error.status
            : undefined;
      if (status !== undefined && !transientAttachmentStatus(status)) throw attachmentStageFailure(stage, error);
      if (attempt >= MAX_ATTACHMENT_ATTEMPTS) throw attachmentStageFailure(stage, error);
      await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMilliseconds(error)));
    }
  }
  throw new AttachmentStageFailure(stage);
}

async function readAttachmentBody(
  response: Response,
  destination: Awaited<ReturnType<typeof open>>,
  rootPath: string,
  signal: AbortSignal,
  declaredLength?: number,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let readerCancellation: Promise<void> | undefined;
  const cancelReader = (): void => {
    readerCancellation ??= reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  let completed = false;
  let total = 0;
  let currentStorage = await attachmentStorageBytes(rootPath);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (signal.aborted) throw new AttachmentRetryableFailure();
        if (declaredLength !== undefined && total !== declaredLength) {
          throw new AttachmentDownloadFailure("Telegram attachment download failed.");
        }
        completed = true;
        return;
      }
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > MAX_ATTACHMENT_BYTES - total) {
        throw new AttachmentDownloadFailure("Attachment exceeds Telegram's 20 MB bot download limit.");
      }
      if (currentStorage + value.byteLength > MAX_ATTACHMENT_STORAGE_BYTES) {
        throw new AttachmentQuotaFailure("Attachment storage quota exceeded");
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await destination.write(value, offset, value.byteLength - offset);
        if (result.bytesWritten <= 0) throw new AttachmentDownloadFailure("Telegram attachment download failed.");
        offset += result.bytesWritten;
      }
      total += value.byteLength;
      currentStorage += value.byteLength;
      if (signal.aborted) throw new AttachmentRetryableFailure();
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (!completed) cancelReader();
    await readerCancellation;
    reader.releaseLock();
  }
}

function attachmentTimeout<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      controller.abort();
      settled = true;
      clearTimeout(timer);
      reject(new AttachmentRetryableFailure());
    }, ATTACHMENT_FETCH_TIMEOUT_MS);
    timer.unref?.();
    operation.then(
      (value) => {
        if (settled || timedOut) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled || timedOut) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function downloadAttachmentBody(
  response: Response,
  destination: Awaited<ReturnType<typeof open>>,
  rootPath: string,
  controller: AbortController,
): Promise<void> {
  try {
    const header = response.headers.get("content-length");
    const contentLength = header !== null ? Number(header) : NaN;
    const declaredLength = Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : undefined;
    await attachmentTimeout(readAttachmentBody(response, destination, rootPath, controller.signal, declaredLength), controller);
  } catch (error) {
    if (error instanceof AttachmentQuotaFailure || (error instanceof AttachmentDownloadFailure && error.message.startsWith("Attachment exceeds"))) throw error;
    throw attachmentStageFailure("file download", error);
  }
}

async function fetchAttachmentResponse(config: Config, filePath: string, signal: AttachmentAbortSignal): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/file/bot${config.token}/${filePath}`, { signal });
  if (response.ok) return response;
  await response.body?.cancel().catch(() => {});
  if (transientAttachmentStatus(response.status)) {
    throw new AttachmentRetryableFailure(response.status, retryAfterHeaderMilliseconds(response));
  }
  throw new AttachmentDownloadFailure(undefined, response.status);
}

async function saveAttachment(
  response: Response,
  controller: AbortController,
  attachmentDirectory: AttachmentDirectory,
  attachmentsRoot: string,
  filename: string,
): Promise<void> {
  const directory = attachmentDirectory.path;
  const finalPath = path.join(directory, filename);
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: string | undefined;
  let createdFinal = false;
  try {
    temporary = path.join(directory, `.${filename}.${randomUUID()}.part`);
    try {
      temporaryHandle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (error) {
      await cancelAttachmentResponse(response, controller);
      throw error;
    }
    await downloadAttachmentBody(response, temporaryHandle, attachmentsRoot, controller);
    await temporaryHandle.close();
    temporaryHandle = undefined;
    try {
      await link(temporary, finalPath);
      createdFinal = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await verifyExistingAttachment(attachmentDirectory, filename))) {
        throw new AttachmentDownloadFailure("Telegram attachment download failed.");
      }
    }
    if (createdFinal) {
      try {
        await rm(temporary, { force: true });
        await verifyAttachmentDirectory(attachmentDirectory);
        await enforceAttachmentQuota(attachmentsRoot);
      } catch (error) {
        await rm(finalPath, { force: true });
        throw error;
      }
    } else {
      await rm(temporary, { force: true });
    }
  } finally {
    await cancelAttachmentResponse(response, controller);
    await temporaryHandle?.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true });
  }
}

async function downloadAttachment(
  bot: Bot,
  config: Config,
  chatId: number,
  message: Message,
  source: AttachmentSource,
  edited = false,
): Promise<SavedAttachment> {
  const common = { type: source.type, mimeType: source.mimeType, originalName: source.originalName };
  if (source.fileSize !== undefined && source.fileSize > MAX_ATTACHMENT_BYTES) {
    return { ...common, failure: "Attachment exceeds Telegram's 20 MB bot download limit." };
  }
  let attachmentDirectory: AttachmentDirectory | undefined;
  try {
    const date = attachmentDate(message);
    const entryId = attachmentEntryId(message, source, edited);
    const fileAttempt = await retryAttachment(
      "getFile",
      (signal) => Promise.resolve().then(() => bot.api.getFile(source.fileId, signal)),
    );
    const file = fileAttempt.value;
    if (!file.file_path) return { ...common, failure: "Telegram attachment download failed during getFile." };
    const filename = safeFilename(source.originalName, fallbackName(source, file.file_path));
    attachmentDirectory = await ensureAttachmentDirectory(config.attachments, chatId, date, entryId);
    const exposedPath = `/run/attachments/${config.attachmentPrefix}/${chatId}/${date}/${entryId}/${filename}`;
    if (await verifyExistingAttachment(attachmentDirectory, filename)) {
      return { ...common, path: exposedPath };
    }

    const responseAttempt = await retryAttachment(
      "file download",
      (signal) => fetchAttachmentResponse(config, file.file_path!, signal),
    );
    const response = responseAttempt.value;
    const controller = responseAttempt.controller;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
      await cancelAttachmentResponse(response, controller);
      return { ...common, failure: "Attachment exceeds Telegram's 20 MB bot download limit." };
    }
    await saveAttachment(response, controller, attachmentDirectory, attachmentWorkspaceRoot(config.attachments), filename);
    return {
      ...common,
      path: exposedPath,
    };
  } catch (error) {
    if (error instanceof AttachmentQuotaFailure) return { ...common, failure: error.message };
    if (error instanceof AttachmentDownloadFailure) {
      if (error.message.startsWith("Attachment exceeds")) return { ...common, failure: error.message };
      return { ...common, failure: "Telegram attachment download failed during file download." };
    }
    if (error instanceof AttachmentStageFailure) return { ...common, failure: `Telegram attachment download failed during ${error.stage}.` };
    const failure = attachmentStageFailure("unknown", error);
    return { ...common, failure: `Telegram attachment download failed during ${failure.stage}.` };
  } finally {
    await attachmentDirectory?.handle.close();
  }
}

async function prepareMessage(bot: Bot, config: Config, ctx: Context, edited = false): Promise<SavedAttachment[]> {
  const message = ctx.msg;
  if (!message) return [];
  const source = attachmentSource(message);
  return source
    ? [await downloadAttachment(bot, config, ctx.chat!.id, message, source, edited)]
    : [];
}



export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: "restart", description: "Restart all agents after settings changes" },
    { command: "start", description: "Introduction" },
  ]);
}




export function isMessageDirectedToBot(message: Message, botInfo?: { id: number; username?: string }): boolean {
  if (!botInfo) return true;
  if (message.reply_to_message?.from?.id === botInfo.id) return true;

  const botUsername = botInfo.username?.toLowerCase();
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];

  for (const entity of entities) {
    if (entity.type === "text_mention" && entity.user?.id === botInfo.id) return true;
    if (entity.type === "mention" && botUsername) {
      const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mention === `@${botUsername}`) return true;
    }
    if (entity.type === "bot_command" && botUsername) {
      const command = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (command.endsWith(`@${botUsername}`)) return true;
    }
  }
  return false;
}

/** True when a my_chat_member update reflects the bot being added to a chat (not a permission change). */
export function isBotGroupAdd(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("new_chat_member" in value) || !("old_chat_member" in value)) return false;
  const newChatMember = value.new_chat_member;
  const oldChatMember = value.old_chat_member;
  if (newChatMember === null || typeof newChatMember !== "object" || oldChatMember === null || typeof oldChatMember !== "object") return false;
  const newStatus = "status" in newChatMember ? newChatMember.status : undefined;
  const oldStatus = "status" in oldChatMember ? oldChatMember.status : undefined;
  return (newStatus === "member" || newStatus === "administrator") && (oldStatus === "left" || oldStatus === "kicked");
}

async function isChatAllowed(workspace: string, chatId: number): Promise<boolean> {
  const allowed = await readAllowedFile(workspace);
  return allowed.status === "ready" && allowed.chats.includes(chatId);
}
function allowlistFingerprint(allowed: Awaited<ReturnType<typeof readAllowedFile>>): string {
  return createHash("sha256").update(JSON.stringify(allowed)).digest("hex");
}
const SERVICE_MESSAGE_FIELDS = new Set([
  "forum_topic_created", "forum_topic_closed", "forum_topic_reopened", "forum_topic_edited",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "new_chat_members", "left_chat_member",
  "new_chat_title", "new_chat_photo", "delete_chat_photo", "group_chat_created", "supergroup_chat_created",
  "channel_chat_created", "message_auto_delete_timer_changed", "migrate_to_chat_id", "migrate_from_chat_id",
  "pinned_message", "video_chat_scheduled", "video_chat_started", "video_chat_ended", "video_chat_participants_invited",
]);

function hasUserContent(message: Record<string, unknown>): boolean {
  return ![...SERVICE_MESSAGE_FIELDS].some((field) => field in message);
}

const MAX_ACCESS_IDENTITY_TEXT = 128;

function accessIdentityText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, MAX_ACCESS_IDENTITY_TEXT);
}

function accessRequester(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const user = value as Record<string, unknown>;
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return undefined;
  const username = accessIdentityText(user.username);
  const firstName = accessIdentityText(user.first_name);
  const lastName = accessIdentityText(user.last_name);
  return {
    id: user.id,
    ...(username === undefined ? {} : { username }),
    ...(firstName === undefined ? {} : { first_name: firstName }),
    ...(lastName === undefined ? {} : { last_name: lastName }),
  };
}

function accessRequestPayload(ctx: Context, reason: string, updateType: string): Record<string, unknown> {
  const chat = ctx.chat!;
  const title = "title" in chat ? accessIdentityText(chat.title) : undefined;
  const requester = chat.id > 0
    ? accessRequester(ctx.from)
    : ctx.myChatMember && isBotGroupAdd(ctx.myChatMember)
      ? accessRequester(ctx.myChatMember.from)
      : undefined;
  return {
    reason,
    update_type: updateType,
    chat: {
      id: chat.id,
      type: chat.type,
      ...(title === undefined ? {} : { title }),
    },
    ...(requester === undefined ? {} : { requester }),
  };
}


type AgentHostAccess = { restartAll(): Promise<void> };

export function createTelegramBot(
  config: Config,
  timeline: WorkspaceTimeline,
  resources: WorkspaceResources,
  deliveryQueue: TelegramDeliveryQueue = new TelegramDeliveryQueue(),
  agent?: AgentHostAccess,
): Bot {
  const bot = new Bot(config.token);
  const workspace = config.workspace;
  const queuedReply = (ctx: Context, text: string) => deliveryQueue.enqueue(ctx.chat!.id, async () => {
    if (!(await isChatAllowed(workspace, ctx.chat!.id))) return;
    await ctx.reply(text);
  });
  const rejectedIngress = new Map<string, { state: string; expiresAt: number }>();

  bot.use(async (ctx, next) => {
    // poll_answer updates carry no chat; their handler resolves ownership and gates them.
    const chat = ctx.chat;
    if (!chat) {
      await next();
      return;
    }
    const updateType = Object.keys(ctx.update).find((key) => key !== "update_id") ?? "unknown";
    const allowed = Number.isSafeInteger(chat.id) ? await readAllowedFile(workspace) : { status: "malformed" as const };
    if (allowed.status === "ready" && allowed.chats.includes(chat.id)) {
      const chatRejectionPrefix = `[${String(chat.id)},`;
      for (const key of rejectedIngress.keys()) {
        if (key.startsWith(chatRejectionPrefix)) rejectedIngress.delete(key);
      }
      await next();
      return;
    }
    const reason = allowed.status === "ready" ? "chat_not_allowed" : `allowlist_${allowed.status}`;
    const now = Date.now();
    for (const [key, { expiresAt }] of rejectedIngress) {
      if (expiresAt <= now) rejectedIngress.delete(key);
    }
    const rejectionKey = JSON.stringify([chat.id, updateType]);
    const rejectionState = `${reason}:${allowlistFingerprint(allowed)}`;
    const previous = rejectedIngress.get(rejectionKey);
    if (previous?.state === rejectionState && previous.expiresAt > now) return;
    while (rejectedIngress.size >= MAX_REJECTED_INGRESS) {
      const oldest = rejectedIngress.keys().next().value;
      if (typeof oldest !== "string") break;
      rejectedIngress.delete(oldest);
    }
    const entry = { state: rejectionState, expiresAt: now + REJECTED_INGRESS_TTL_MS };
    rejectedIngress.set(rejectionKey, entry);
    try {
      await timeline.publish({
        type: "telegram.access_request",
        connectorId: config.id,
        payload: accessRequestPayload(ctx, reason, updateType),
      });
    } catch (error) {
      if (rejectedIngress.get(rejectionKey) === entry) rejectedIngress.delete(rejectionKey);
      throw error;
    }
  });

  bot.command("start", async (ctx) => {
    await queuedReply(ctx, "Personal agent. Send text, attachments, or a location pin to continue your persistent session.");
  });


  bot.command("restart", async (ctx) => {
    if (!agent) {
      await queuedReply(ctx, "Restart is not available.");
      return;
    }
    try {
      await agent.restartAll();
    } catch (error) {
      console.error("Failed to restart agents", error);
      await queuedReply(ctx, "I could not restart the agents. Please try again.");
      return;
    }
    await queuedReply(ctx, "Restarting all agents. They will resume on the next message.");
  });

  const persistMessage = async (ctx: Context): Promise<void> => {
    const incoming = ctx.msg;
    const chat = ctx.chat;
    if (!incoming || !chat) return;
    const message = incoming as unknown as Record<string, unknown>;
    const chatId = chat.id;
    const threadId = typeof message.message_thread_id === "number" ? message.message_thread_id : 0;
    const conversation = telegramConversation(config.id, chatId, threadId);
    const attachments = await prepareMessage(bot, config, ctx);
    const ownership = [
      { connectorId: config.id, kind: "message" as const, key: `${chatId}:${incoming.message_id}`, owner: conversation },
      ...(incoming.poll?.id ? [{ connectorId: config.id, kind: "poll" as const, key: incoming.poll.id, owner: conversation }] : []),
    ];
    await resources.setMany(ownership);
    await timeline.publish({
      type: "telegram.message",
      connectorId: config.id,
      conversation,
      payload: incoming,
      attachments,
      meta: {
        private: chatId > 0,
        directed: isMessageDirectedToBot(incoming, bot.botInfo),
        user_content: hasUserContent(message),
        ...(chat.type === "channel" ? { channel: true } : {}),
      }
    });
  };
  bot.on(["message", "channel_post"], persistMessage);

  const persistEditedMessage = async (ctx: Context): Promise<void> => {
    const incoming = ctx.msg;
    const chat = ctx.chat;
    if (!incoming || !chat) return;
    const message = incoming as unknown as Record<string, unknown>;
    const chatId = chat.id;
    const threadId = typeof message.message_thread_id === "number" ? message.message_thread_id : 0;
    const conversation = telegramConversation(config.id, chatId, threadId);
    const attachments = await prepareMessage(bot, config, ctx, true);
    await resources.set({ connectorId: config.id, kind: "message", key: `${chatId}:${incoming.message_id}`, owner: conversation });
    await timeline.publish({ type: "telegram.edited_message", connectorId: config.id, conversation, payload: incoming, attachments });
  };
  bot.on(["edited_message", "edited_channel_post"], persistEditedMessage);
  bot.on("callback_query", async (ctx) => {
    const query = ctx.callbackQuery;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const threadId = query.message?.message_thread_id ?? 0;
    const conversation = telegramConversation(config.id, chatId, threadId);
    void ctx.answerCallbackQuery().catch(() => {});
    await timeline.publish({ type: "telegram.callback", connectorId: config.id, conversation, payload: query });
  });
  bot.on("poll_answer", async (ctx) => {
    const answer = ctx.pollAnswer;
    const owner = resources.owner(config.id, "poll", answer.poll_id);
    if (owner === undefined) return;
    const address = telegramAddress(owner, config.id);
    if (!(await isChatAllowed(workspace, address.chat_id))) return;
    await timeline.publish({ type: "telegram.poll_answer", connectorId: config.id, conversation: owner, payload: answer });
  });
  bot.on("message_reaction", async (ctx) => {
    const reaction = ctx.messageReaction;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const owner = resources.owner(config.id, "message", `${chatId}:${reaction.message_id}`);
    const threadId = "message_thread_id" in reaction && typeof reaction.message_thread_id === "number" ? reaction.message_thread_id : 0;
    const conversation = owner ?? telegramConversation(config.id, chatId, threadId);
    await timeline.publish({ type: "telegram.message_reaction", connectorId: config.id, conversation, payload: reaction });
  });
  bot.on("my_chat_member", async (ctx) => {
    const member = ctx.myChatMember;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    await timeline.publish({
      type: "telegram.my_chat_member",
      connectorId: config.id,
      conversation: telegramConversation(config.id, chatId),
      payload: member,
      meta: { group_add: chatId < 0 && isBotGroupAdd(member) },
    });
  });
  bot.on("chat_join_request", async (ctx) => {
    const request = ctx.chatJoinRequest;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    await timeline.publish({ type: "telegram.chat_join_request", connectorId: config.id, conversation: telegramConversation(config.id, chatId), payload: request });
  });
  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) console.error("Telegram API error", cause.description);
    else if (cause instanceof HttpError) console.error("Telegram transport error", cause);
    else console.error("Telegram update error", cause);
  });

  return bot;
}
