import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "./config.js";
import { chatPaths } from "./config.js";
import type { AgentManager } from "./agent.js";
import { SerialQueue } from "./queue.js";

const INGRESS_COOLDOWN_MS = 2_000;
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram Bot API download limit for incoming attachments (20 MiB).

const MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_CAPTION_LENGTH = 1_024;
const OUTBOUND_READ_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;

type AttachmentSource = {
  type: string;
  fileId: string;
  fileSize?: number | undefined;
  mimeType?: string | undefined;
  originalName?: string | undefined;
};

export type SavedAttachment = {
  type: string;
  path?: string | undefined;
  mimeType?: string | undefined;
  originalName?: string | undefined;
  failure?: string | undefined;
};

export type BufferedTelegramMessage = {
  messageId: number;
  text?: string | undefined;
  attachments: SavedAttachment[];
};

export type TelegramBatchResult =
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "no-reply"; readonly reason: "steered" };

export type TelegramIngressAdmission =
  | { readonly kind: "accepted" }
  | { readonly kind: "quiesced"; readonly reason: "closed" };

export type TelegramIngressEntry = {
  value: PromiseLike<BufferedTelegramMessage>;
  respond: (text: string) => void | PromiseLike<void>;
  typing: () => void | PromiseLike<void>;
};

type BufferEntry = TelegramIngressEntry;

type PendingBatch = {
  readonly chatId: number;
  readonly entries: readonly BufferEntry[];
  readonly owner: BufferEntry;
};

type IngressBarrierState = {
  pending: number;
  owners: number;
  released: Promise<void>;
  resolveReleased: () => void;
};

type BufferState = {
  pending: BufferEntry[];
  timer: NodeJS.Timeout | undefined;
  generation: number;
  tail: Promise<void>;
  running: Set<Promise<void>>;
  barrier: IngressBarrierState | undefined;
};

export type TelegramIngressBarrier = {
  release: () => void;
};

const DELIVERY_FAILURE_MESSAGE = "I could not complete that request. Please try again.";

function invokeCallback<T>(callback: () => T | PromiseLike<T>): Promise<T> {
  return Promise.resolve().then(callback);
}

function isTelegramBatchResult(value: unknown): value is TelegramBatchResult {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const result = value as { kind?: unknown; text?: unknown; reason?: unknown };
  if (result.kind === "reply") return typeof result.text === "string";
  return result.kind === "no-reply" && result.reason === "steered";
}

export class TelegramIngressBuffer {
  private closed = false;
  private readonly states = new Map<number, BufferState>();

  constructor(
    private readonly flushBatch: (chatId: number, messages: BufferedTelegramMessage[]) => TelegramBatchResult | PromiseLike<TelegramBatchResult>,
    private readonly cooldownMs = INGRESS_COOLDOWN_MS,
  ) {}

  add(chatId: number, entry: BufferEntry): TelegramIngressAdmission {
    if (this.closed) return { kind: "quiesced", reason: "closed" };
    let state = this.states.get(chatId);
    if (!state) {
      state = {
        pending: [],
        timer: undefined,
        generation: 0,
        tail: Promise.resolve(),
        running: new Set(),
        barrier: undefined,
      };
      this.states.set(chatId, state);
    }
    state.pending.push(entry);
    if (!state.barrier) this.schedule(chatId, state);
    return { kind: "accepted" };
  }

  acquireBarrier(chatId: number): TelegramIngressBarrier {
    let state = this.states.get(chatId);
    if (!state) {
      state = {
        pending: [],
        timer: undefined,
        generation: 0,
        tail: Promise.resolve(),
        running: new Set(),
        barrier: undefined,
      };
      this.states.set(chatId, state);
    }
    if (!state.barrier) {
      this.cancelTimer(state);
      let resolveReleased!: () => void;
      const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
      state.barrier = {
        pending: state.pending.length,
        owners: 0,
        released,
        resolveReleased,
      };
    }
    const barrier = state.barrier!;
    barrier.owners += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseBarrier(chatId, state!, barrier);
      },
    };
  }

  private releaseBarrier(chatId: number, state: BufferState, barrier: IngressBarrierState): void {
    if (state.barrier !== barrier) return;
    barrier.owners -= 1;
    if (barrier.owners > 0) return;
    state.barrier = undefined;
    barrier.resolveReleased();
    if (state.pending.length > 0 && !this.closed) this.schedule(chatId, state);
    this.maybeDelete(chatId, state);
  }

  private schedule(chatId: number, state: BufferState): void {
    if (state.timer) clearTimeout(state.timer);
    const generation = ++state.generation;
    state.timer = setTimeout(() => {
      if (this.states.get(chatId) !== state || state.generation !== generation) return;
      state.timer = undefined;
      void this.flush(chatId).catch((error) => {
        console.error("Buffered Telegram timer flush failed", error);
      });
    }, this.cooldownMs);
    state.timer.unref?.();
  }

  private cancelTimer(state: BufferState): void {
    ++state.generation;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
  }

  private claim(chatId: number, state: BufferState, maxEntries = Number.POSITIVE_INFINITY): Promise<void> | undefined {
    if (state.pending.length === 0) return undefined;
    const count = Math.min(maxEntries, state.pending.length);
    const entries = state.pending.splice(0, count);
    const owner = entries.at(-1);
    if (!owner) return undefined;
    if (state.barrier) state.barrier.pending -= entries.length;
    this.cancelTimer(state);
    const batch: PendingBatch = Object.freeze({
      chatId,
      entries: Object.freeze(entries),
      owner,
    });
    const job = state.tail.then(
      () => this.executeBatch(batch),
      () => this.executeBatch(batch),
    );
    state.tail = job;
    state.running.add(job);
    void job.then(
      () => {
        state.running.delete(job);
        this.maybeDelete(chatId, state);
      },
      (error) => {
        state.running.delete(job);
        console.error("Buffered Telegram batch failed", error);
        this.maybeDelete(chatId, state);
      },
    );
    return job;
  }

  private maybeDelete(chatId: number, state: BufferState): void {
    if (state.pending.length === 0 && state.running.size === 0 && !state.timer && !state.barrier && this.states.get(chatId) === state) {
      this.states.delete(chatId);
    }
  }

  private async executeBatch(batch: PendingBatch): Promise<void> {
    let typing: NodeJS.Timeout | undefined;
    try {
      void invokeCallback(batch.owner.typing).catch((error) => {
        console.error("Buffered Telegram initial typing notification failed", error);
      });
      typing = setInterval(() => {
        void invokeCallback(batch.owner.typing).catch((error) => {
          console.error("Buffered Telegram typing notification failed", error);
        });
      }, 4_000);
      typing.unref?.();

      const messages = await Promise.all(batch.entries.map((entry) => Promise.resolve(entry.value)));
      const result = await invokeCallback(() => this.flushBatch(batch.chatId, messages));
      if (!isTelegramBatchResult(result)) throw new Error("Buffered Telegram handler returned an invalid batch result");
      if (result.kind === "reply") {
        try {
          await invokeCallback(() => batch.owner.respond(result.text));
        } catch (error) {
          console.error("Buffered Telegram response delivery failed", error);
        }
      }
    } catch (error) {
      console.error("Buffered Telegram request failed", error);
      try {
        await invokeCallback(() => batch.owner.respond(DELIVERY_FAILURE_MESSAGE));
      } catch (deliveryError) {
        console.error("Buffered Telegram failure response delivery failed", deliveryError);
      }
    } finally {
      if (typing) clearInterval(typing);
    }
  }

  async flush(chatId: number): Promise<void> {
    const state = this.states.get(chatId);
    if (!state) return;
    while (true) {
      const barrier = state.barrier;
      if (barrier) {
        this.claim(chatId, state, barrier.pending);
        await state.tail;
        this.maybeDelete(chatId, state);
        return;
      }
      this.claim(chatId, state);
      const tail = state.tail;
      await tail;
      if (state.pending.length === 0 && state.running.size === 0 && !state.barrier) break;
    }
    this.maybeDelete(chatId, state);
  }

  close(): void {
    this.closed = true;
    for (const state of this.states.values()) this.cancelTimer(state);
    for (const [chatId, state] of this.states) this.maybeDelete(chatId, state);
  }

  async flushAll(): Promise<void> {
    while (true) {
      const states = [...this.states.entries()];
      if (states.length === 0) return;
      const barriers = states
        .map(([, state]) => state.barrier?.released)
        .filter((released): released is Promise<void> => released !== undefined);
      await Promise.all(states.map(([chatId, state]) => {
        if (this.states.get(chatId) !== state) return Promise.resolve();
        return this.flush(chatId);
      }));
      if (barriers.length > 0) {
        await Promise.all(barriers);
        continue;
      }
      const outstanding = [...this.states.values()].some((state) => state.pending.length > 0 || state.running.size > 0);
      if (!outstanding) return;
    }
  }
}
type TelegramDeliveryOperation<T> = () => T | PromiseLike<T>;

export class TelegramDeliveryQueue {
  private readonly states = new Map<number, SerialQueue>();
  private readonly pending = new Set<Promise<unknown>>();

  enqueue<T>(chatId: number, operation: TelegramDeliveryOperation<T>): Promise<T> {
    let state = this.states.get(chatId);
    if (!state) {
      state = new SerialQueue();
      this.states.set(chatId, state);
    }

    const result = state.run(() => invokeCallback(operation));
    this.pending.add(result);
    const complete = () => { this.complete(chatId, state!, result); };
    void result.then(complete, complete);
    return result;
  }

  private complete(chatId: number, state: SerialQueue, result: Promise<unknown>): void {
    this.pending.delete(result);
    if (state.size === 0 && this.states.get(chatId) === state) this.states.delete(chatId);
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const accepted = [...this.pending];
      await Promise.all(accepted.map((operation) => operation.catch(() => undefined)));
      await Promise.resolve();
    }
  }
}


export function splitTelegramText(text: string, limit = 4000): string[] {
  if (limit < 1) throw new Error("limit must be positive");
  if (!text) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf(" ", limit);
    if (cut < 1) cut = limit;
    else cut = Math.min(limit, cut + (rest[cut] === "\n" && rest[cut + 1] === "\n" ? 2 : 1));
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function replyChunks(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitTelegramText(text)) await ctx.reply(chunk);
}

export async function sendTelegramText(bot: Bot, chatId: number, text: string): Promise<void> {
  for (const chunk of splitTelegramText(text)) await bot.api.sendMessage(chatId, chunk);
}

export type WorkspaceFileRequest = {
  chatId: number;
  workspace: string;
  sandboxPath: string;
  caption?: string | undefined;
};

function isWithinWorkspace(workspace: string, candidate: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function workspaceCandidate(workspace: string, sandboxPath: string): string {
  if (path.isAbsolute(sandboxPath)) {
    if (sandboxPath !== "/workspace" && !sandboxPath.startsWith("/workspace/")) {
      throw new Error("File path must be relative to /workspace.");
    }
    const relative = sandboxPath.slice("/workspace".length).replace(/^\/+/, "");
    return path.resolve(workspace, relative);
  }
  return path.resolve(workspace, sandboxPath);
}

export async function sendWorkspaceFile(bot: Bot, request: WorkspaceFileRequest): Promise<string> {
  let workspace: string;
  try {
    workspace = await realpath(request.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace is not a directory.");
  } catch (error) {
    if (error instanceof Error && error.message === "Workspace is not a directory.") throw error;
    throw new Error("Workspace is unavailable.");
  }

  const candidate = workspaceCandidate(workspace, request.sandboxPath);
  if (!isWithinWorkspace(workspace, candidate)) throw new Error("File path escapes the workspace.");

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error("File does not exist.");
  }
  if (!isWithinWorkspace(workspace, resolved)) throw new Error("File path resolves outside the workspace.");

  const handle = await open(resolved, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING).catch(() => {
    throw new Error("File does not exist.");
  });
  try {
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!isWithinWorkspace(workspace, openedPath)) throw new Error("File path resolves outside the workspace.");
    const file = await handle.stat();
    if (!file.isFile()) throw new Error("Path is not a regular file.");
    if (file.size > MAX_OUTBOUND_FILE_BYTES) throw new Error("File exceeds the 20 MiB upload limit.");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_OUTBOUND_FILE_BYTES) {
      const length = Math.min(OUTBOUND_READ_CHUNK_BYTES, MAX_OUTBOUND_FILE_BYTES + 1 - total);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_OUTBOUND_FILE_BYTES) throw new Error("File exceeds the 20 MiB upload limit.");
    const bytes = Buffer.concat(chunks, total);

    const caption = request.caption === undefined
      ? undefined
      : Array.from(request.caption).slice(0, MAX_TELEGRAM_CAPTION_LENGTH).join("");
    await bot.api.sendDocument(
      request.chatId,
      new InputFile(bytes, path.basename(resolved)),
      caption === undefined ? undefined : { caption },
    );
  } finally {
    await handle.close();
  }
  return `Sent ${path.basename(resolved)}.`;
}
type AttachmentDirectory = {
  path: string;
  expectedPath: string;
  handle: Awaited<ReturnType<typeof open>>;
};

async function ensureAttachmentDirectory(workspace: string, date: string, messageId: number): Promise<AttachmentDirectory> {
  const expectedWorkspace = path.resolve(workspace);
  try {
    const entry = await lstat(expectedWorkspace);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Attachment workspace is not safe.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(expectedWorkspace, { recursive: true, mode: 0o700 });
  }
  const workspaceEntry = await lstat(expectedWorkspace).catch(() => undefined);
  if (!workspaceEntry || workspaceEntry.isSymbolicLink() || !workspaceEntry.isDirectory()) {
    throw new Error("Attachment workspace is not safe.");
  }
  const root = await realpath(expectedWorkspace);
  if (root !== expectedWorkspace) throw new Error("Attachment workspace is not safe.");
  let directory = root;
  for (const segment of ["attachments", date, String(messageId)]) {
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
    handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!isWithinWorkspace(root, openedPath)) throw new Error("Attachment directory is not safe.");
    return { path: `/proc/self/fd/${handle.fd}`, expectedPath: directory, handle };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

function cancelAttachmentResponse(response: Response, controller: AbortController): void {
  controller.abort();
  if (response.body) void response.body.cancel().catch(() => {});
}

async function verifyAttachmentDirectory(directory: AttachmentDirectory): Promise<void> {
  const live = await lstat(directory.expectedPath);
  const pinned = await directory.handle.stat();
  if (!live.isDirectory() || live.dev !== pinned.dev || live.ino !== pinned.ino) {
    throw new AttachmentDownloadFailure("Telegram attachment download failed.");
  }
}

function safeFilename(name: string | undefined, fallback: string): string {
  const base = path.basename(name?.trim() || fallback)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 48);
  return base || fallback;
}

function attachmentSource(message: Message): AttachmentSource | undefined {
  if (message.animation) return {
    type: "animation", fileId: message.animation.file_id, fileSize: message.animation.file_size,
    mimeType: message.animation.mime_type, originalName: message.animation.file_name,
  };
  if (message.audio) return {
    type: "audio", fileId: message.audio.file_id, fileSize: message.audio.file_size,
    mimeType: message.audio.mime_type, originalName: message.audio.file_name,
  };
  if (message.document) return {
    type: "document", fileId: message.document.file_id, fileSize: message.document.file_size,
    mimeType: message.document.mime_type, originalName: message.document.file_name,
  };
  if (message.photo?.length) {
    const photo = message.photo.at(-1)!;
    return { type: "photo", fileId: photo.file_id, fileSize: photo.file_size, mimeType: "image/jpeg" };
  }
  if (message.sticker) return {
    type: "sticker", fileId: message.sticker.file_id, fileSize: message.sticker.file_size,
    mimeType: message.sticker.is_animated ? "application/x-tgsticker" : message.sticker.is_video ? "video/webm" : "image/webp",
  };
  if (message.video) return {
    type: "video", fileId: message.video.file_id, fileSize: message.video.file_size,
    mimeType: message.video.mime_type, originalName: message.video.file_name,
  };
  if (message.video_note) return {
    type: "video_note", fileId: message.video_note.file_id, fileSize: message.video_note.file_size, mimeType: "video/mp4",
  };
  if (message.voice) return {
    type: "voice", fileId: message.voice.file_id, fileSize: message.voice.file_size, mimeType: message.voice.mime_type,
  };
  return undefined;
}

function fallbackName(source: AttachmentSource, remotePath?: string): string {
  const remoteName = remotePath ? path.posix.basename(remotePath) : undefined;
  if (remoteName && remoteName.includes(".")) return remoteName;
  const extension: Record<string, string> = {
    animation: ".mp4", audio: ".audio", document: ".bin", photo: ".jpg", sticker: ".webp",
    video: ".mp4", video_note: ".mp4", voice: ".ogg",
  };
  return `${source.type}${extension[source.type] ?? ".bin"}`;
}

class AttachmentDownloadFailure extends Error {}

async function readAttachmentBody(response: Response, destination: Awaited<ReturnType<typeof open>>, signal: AbortSignal): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > MAX_ATTACHMENT_BYTES - total) {
        throw new AttachmentDownloadFailure("Attachment exceeds Telegram's 20 MB bot download limit.");
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await destination.write(value, offset, value.byteLength - offset);
        if (result.bytesWritten <= 0) throw new AttachmentDownloadFailure("Telegram attachment download failed.");
        offset += result.bytesWritten;
      }
      total += value.byteLength;
      if (signal.aborted) throw new AttachmentDownloadFailure("Telegram attachment download timed out.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function attachmentTimeout<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AttachmentDownloadFailure("Telegram attachment download timed out."));
    }, ATTACHMENT_FETCH_TIMEOUT_MS);
    timer.unref?.();
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function downloadAttachment(
  bot: Bot,
  config: Config,
  chatId: number,
  message: Message,
  source: AttachmentSource,
): Promise<SavedAttachment> {
  const common = { type: source.type, mimeType: source.mimeType, originalName: source.originalName };
  if (source.fileSize !== undefined && source.fileSize > MAX_ATTACHMENT_BYTES) {
    return { ...common, failure: "Attachment exceeds Telegram's 20 MB bot download limit." };
  }
  try {
    const controller = new AbortController();
    const file = await attachmentTimeout(
      Promise.resolve().then(() => bot.api.getFile(source.fileId)),
      controller,
    );
    if (!file.file_path) return { ...common, failure: "Telegram did not provide a downloadable file path." };
    const response = await attachmentTimeout(
      fetch(`https://api.telegram.org/file/bot${config.token}/${file.file_path}`, { signal: controller.signal }),
      controller,
    );
    if (!response.ok) {
      cancelAttachmentResponse(response, controller);
      return { ...common, failure: `Telegram download failed with HTTP ${response.status}.` };
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
      cancelAttachmentResponse(response, controller);
      return { ...common, failure: "Attachment exceeds Telegram's 20 MB bot download limit." };
    }
    const date = new Date(message.date * 1_000).toISOString().slice(0, 10);
    const workspace = chatPaths(config.dataDir, chatId).workspace;
    const attachmentDirectory = await ensureAttachmentDirectory(workspace, date, message.message_id);
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporary: string | undefined;
    try {
      const filename = safeFilename(source.originalName, fallbackName(source, file.file_path));
      const directory = attachmentDirectory.path;
      temporary = path.join(directory, `.${filename}.${randomUUID()}.part`);
      temporaryHandle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      await attachmentTimeout(readAttachmentBody(response, temporaryHandle, controller.signal), controller);
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporary, path.join(directory, filename));
      await verifyAttachmentDirectory(attachmentDirectory);
      return {
        ...common,
        path: `/workspace/attachments/${date}/${message.message_id}/${filename}`,
      };
    } finally {
      await temporaryHandle?.close().catch(() => {});
      if (temporary) await rm(temporary, { force: true });
      await attachmentDirectory.handle.close();
    }
  } catch (error) {
    if (error instanceof AttachmentDownloadFailure) return { ...common, failure: error.message };
    return { ...common, failure: "Telegram attachment download failed." };
  }
}

async function prepareMessage(bot: Bot, config: Config, ctx: Context): Promise<BufferedTelegramMessage> {
  const message = ctx.message!;
  const source = attachmentSource(message);
  const attachments = source
    ? [await downloadAttachment(bot, config, ctx.chat!.id, message, source)]
    : [];
  const text = message.text ?? message.caption;
  if (!text && attachments.length === 0) {
    return {
      messageId: message.message_id,
      text: `[Unsupported Telegram message type received: ${Object.keys(message).filter((key) => !["message_id", "date", "chat", "from"].includes(key)).join(", ") || "unknown"}]`,
      attachments,
    };
  }
  return { messageId: message.message_id, text, attachments };
}

export function formatBufferedPrompt(messages: BufferedTelegramMessage[]): string {
  return messages.map((message) => {
    const parts = [`Telegram message ${message.messageId}:`];
    if (message.text) parts.push(message.text);
    for (const attachment of message.attachments) {
      const metadata = [
        `type=${attachment.type}`,
        attachment.mimeType ? `MIME=${attachment.mimeType}` : undefined,
        attachment.originalName ? `original name=${JSON.stringify(attachment.originalName)}` : undefined,
      ].filter(Boolean).join(", ");
      if (attachment.path) parts.push(`Attachment: ${attachment.path} (${metadata})`);
      else parts.push(`Attachment download failed (${metadata}): ${attachment.failure ?? "unknown failure"}`);
    }
    return parts.join("\n");
  }).join("\n\n");
}

const ingressByBot = new WeakMap<Bot, TelegramIngressBuffer>();

export async function flushTelegramIngress(bot: Bot): Promise<void> {
  await ingressByBot.get(bot)?.flushAll();
}

export function closeTelegramIngress(bot: Bot): void {
  ingressByBot.get(bot)?.close();
}

export function createTelegramBot(
  config: Config,
  agents: AgentManager,
  deliveryQueue: TelegramDeliveryQueue = new TelegramDeliveryQueue(),
): Bot {
  const bot = new Bot(config.token);
  agents.setAssistantProgress((chatId, text) => deliveryQueue.enqueue(chatId, () => sendTelegramText(bot, chatId, text)));
  const queuedReply = (ctx: Context, text: string): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return Promise.resolve();
    return deliveryQueue.enqueue(chatId, () => ctx.reply(text)).then(() => undefined);
  };

  const ingress = new TelegramIngressBuffer(async (chatId, messages) => {
    const response = await agents.prompt(chatId, formatBufferedPrompt(messages));
    return response === undefined
      ? { kind: "no-reply", reason: "steered" }
      : { kind: "reply", text: response };
  });
  ingressByBot.set(bot, ingress);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !config.allowedUserIds.has(userId)) {
      if (ctx.chat) await queuedReply(ctx, "Unauthorized.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await queuedReply(ctx, "Personal agent. Send text or attachments to continue your persistent session, or /new to start a fresh one.");
  });

  bot.command("new", async (ctx) => {
    const barrier = ingress.acquireBarrier(ctx.chat.id);
    let started = false;
    try {
      await ingress.flush(ctx.chat.id);
      await agents.newSession(ctx.chat.id);
      started = true;
    } catch (error) {
      console.error("Failed to start new session", error);
    } finally {
      barrier.release();
    }
    if (!started) {
      await queuedReply(ctx, "I could not start a new session. Please try again.");
      return;
    }
    try {
      await queuedReply(ctx, "Started a new session. Earlier session files remain searchable.");
    } catch (error) {
      console.error("Failed to start new session", error);
      await queuedReply(ctx, "I could not start a new session. Please try again.");
    }
  });

  bot.on("message", async (ctx) => {
    let startPreparation!: () => void;
    const prepared = new Promise<BufferedTelegramMessage>((resolve, reject) => {
      startPreparation = () => { void prepareMessage(bot, config, ctx).then(resolve, reject); };
    });
    const admission = ingress.add(ctx.chat.id, {
      value: prepared,
      respond: (text) => deliveryQueue.enqueue(ctx.chat.id, () => replyChunks(ctx, text)),
      typing: async () => { await ctx.replyWithChatAction("typing"); },
    });
    if (admission.kind === "accepted") startPreparation();
  });

  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) console.error("Telegram API error", cause.description);
    else if (cause instanceof HttpError) console.error("Telegram transport error", cause);
    else console.error("Telegram update error", cause);
  });

  return bot;
}
