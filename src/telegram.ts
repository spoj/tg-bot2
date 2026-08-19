import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import type { Message, Poll } from "grammy/types";
import type { Config } from "./config.js";
import type { AgentManager, AgentStatus } from "./agent.js";
import { SerialQueue } from "./queue.js";
import { appendChatEvent, appendChatEvents, type ChatEvent } from "./events.js";
import type {
  WorkspaceOutboxSendMessageRequest,
  WorkspaceOutboxSendLocationRequest,
  WorkspaceOutboxSendPollRequest,
  WorkspaceOutboxEditMessageRequest,
  WorkspaceOutboxReaction,
  WorkspaceOutboxRequest,
  WorkspaceOutboxDispatchResult,
  WorkspaceOutboxFileKind,
} from "./outbox-protocol.js";

import { appendBoundedJsonl, chatPaths, defined, readBoundedJsonl } from "./util.js";

const INGRESS_COOLDOWN_MS = 2_000;
const WAKE_PROMPT = ".";
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram Bot API download limit for incoming attachments (20 MiB).

const MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_CAPTION_LENGTH = 1_024;
const OUTBOUND_READ_CHUNK_BYTES = 64 * 1024;
const ATTACHMENTS_DIR = "attachments";
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
const NON_BLOCKING = fsConstants.O_NONBLOCK;

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


type BufferEntry = {
  value: PromiseLike<ChatEvent>;
  typing?: () => void | PromiseLike<void>;
};

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

type TelegramIngressBarrier = {
  release: () => void;
};

function invokeCallback<T>(callback: () => T | PromiseLike<T>): Promise<T> {
  return Promise.resolve().then(callback);
}

export class TelegramIngressBuffer {
  private closed = false;
  private readonly states = new Map<number, BufferState>();
  constructor(
    private readonly flushBatch: (chatId: number, events: ChatEvent[]) => void | PromiseLike<void>,
    private readonly cooldownMs = INGRESS_COOLDOWN_MS,
  ) {}

  add(chatId: number, entry: BufferEntry): boolean {
    if (this.closed) return false;
    const state = this.stateFor(chatId);
    state.pending.push(entry);
    if (!state.barrier) this.schedule(chatId, state);
    return true;
  }

  private stateFor(chatId: number): BufferState {
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
    return state;
  }

  acquireBarrier(chatId: number): TelegramIngressBarrier {
    const state = this.stateFor(chatId);
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
      void this.flush(chatId);
    }, this.cooldownMs);
    state.timer.unref?.();
  }

  private cancelTimer(state: BufferState): void {
    ++state.generation;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
  }

  private claim(chatId: number, state: BufferState, maxEntries = Number.POSITIVE_INFINITY): void {
    if (state.pending.length === 0) return;
    const count = Math.min(maxEntries, state.pending.length);
    const entries = state.pending.splice(0, count);
    const owner = entries.at(-1);
    if (!owner) return;
    if (state.barrier) state.barrier.pending -= entries.length;
    this.cancelTimer(state);
    const batch: PendingBatch = Object.freeze({
      chatId,
      entries,
      owner,
    });
    const job = state.tail.then(() => this.executeBatch(batch));
    state.tail = job;
    state.running.add(job);
    void job.then(() => {
      state.running.delete(job);
    });
  }

  private maybeDelete(chatId: number, state: BufferState): void {
    if (state.pending.length === 0 && state.running.size === 0 && !state.timer && !state.barrier && this.states.get(chatId) === state) {
      this.states.delete(chatId);
    }
  }

  private async executeBatch(batch: PendingBatch): Promise<void> {
    let typing: NodeJS.Timeout | undefined;
    try {
      const typingCallback = batch.owner.typing;
      if (typingCallback) {
        void invokeCallback(typingCallback).catch((error) => {
          console.error("Buffered Telegram initial typing notification failed", error);
        });
        typing = setInterval(() => {
          void invokeCallback(typingCallback).catch((error) => {
            console.error("Buffered Telegram typing notification failed", error);
          });
        }, 4_000);
        typing.unref?.();
      }
      const events = await Promise.all(batch.entries.map((entry) => entry.value));
      await invokeCallback(() => this.flushBatch(batch.chatId, events));
    } catch (error) {
      console.error("Buffered Telegram request failed", error);
    } finally {
      if (typing) clearInterval(typing);
    }
  }

  async flush(chatId: number): Promise<void> {
    const state = this.states.get(chatId);
    if (!state) return;
    while (true) {
      if (state.barrier) {
        this.claim(chatId, state, state.barrier.pending);
        await state.tail;
        break;
      }
      this.claim(chatId, state);
      await state.tail;
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

export async function sendTelegramLocation(bot: Bot, chatId: number, request: WorkspaceOutboxSendLocationRequest): Promise<number> {
  const shared = defined({ reply_to_message_id: request.reply_to_message_id, disable_notification: request.disable_notification });
  if (request.venue) {
    const extra = Object.keys(shared).length === 0 ? [] : [shared as never];
    const sent = await bot.api.sendVenue(chatId, request.latitude, request.longitude, request.venue.title, request.venue.address, ...extra);
    return sent.message_id;
  }
  const sent = await bot.api.sendLocation(chatId, request.latitude, request.longitude, {
    ...defined({ horizontal_accuracy: request.horizontal_accuracy, heading: request.heading, live_period: request.live_period }),
    ...shared,
  });
  return sent.message_id;
}

export async function sendTelegramPoll(bot: Bot, chatId: number, request: WorkspaceOutboxSendPollRequest): Promise<{ messageId: number; pollId: string }> {
  const options = defined({ is_anonymous: request.is_anonymous, allows_multiple_answers: request.allows_multiple_answers, type: request.poll_type, correct_option_id: request.correct_option_id, reply_to_message_id: request.reply_to_message_id, disable_notification: request.disable_notification });
  const sent = await bot.api.sendPoll(chatId, request.question, request.options, options);
  return { messageId: sent.message_id, pollId: sent.poll.id };
}

export async function stopTelegramPoll(bot: Bot, chatId: number, messageId: number, replyMarkup?: unknown): Promise<Poll> {
  return bot.api.stopPoll(chatId, messageId, replyMarkup === undefined ? undefined : { reply_markup: replyMarkup as never });
}

export async function sendTelegramReaction(bot: Bot, chatId: number, messageId: number, reaction: WorkspaceOutboxReaction[]): Promise<void> {
  await bot.api.setMessageReaction(chatId, messageId, reaction as never);
}

function isTelegramParseFailure(error: unknown): boolean {
  return error instanceof GrammyError && /can['’]t parse|cannot parse/i.test(error.description);
}

async function withPlainFallback<T>(parseMode: "HTML" | "MarkdownV2" | undefined, send: (parseMode?: "HTML" | "MarkdownV2") => Promise<T>): Promise<T> {
  try {
    return await send(parseMode);
  } catch (error) {
    if (parseMode === undefined || !isTelegramParseFailure(error)) throw error;
    return await send(undefined);
  }
}

/** Sends one rich message; malformed markup falls back to the same text as plain. */
export async function sendTelegramRichMessage(bot: Bot, chatId: number, request: WorkspaceOutboxSendMessageRequest): Promise<number> {
  return withPlainFallback(request.parse_mode, async (parseMode) => {
    const sent = await bot.api.sendMessage(chatId, request.text, defined({ parse_mode: parseMode, reply_markup: request.reply_markup as never, reply_to_message_id: request.reply_to_message_id, entities: request.entities as never, link_preview_options: request.link_preview_options as never, disable_notification: request.disable_notification }));
    return sent.message_id;
  });
}
/** Edits one message; malformed markup falls back to the same text as plain. */
export async function sendTelegramEditMessage(bot: Bot, chatId: number, request: WorkspaceOutboxEditMessageRequest): Promise<number> {
  return withPlainFallback(request.parse_mode, async (parseMode) => {
    const sent = await bot.api.editMessageText(chatId, request.message_id, request.text, defined({ parse_mode: parseMode, entities: request.entities as never, link_preview_options: request.link_preview_options as never, reply_markup: request.reply_markup as never })) as { message_id: number };
    return sent.message_id;
  });
}

export async function deleteTelegramMessage(bot: Bot, chatId: number, messageId: number): Promise<void> {
  await bot.api.deleteMessage(chatId, messageId);
}

export async function dispatchOutboxRequest(bot: Bot, dataDir: string, chatId: number, request: WorkspaceOutboxRequest): Promise<WorkspaceOutboxDispatchResult | undefined> {
  switch (request.type) {
    case "send_file": return { messageId: await sendWorkspaceFile(bot, { chatId, workspace: chatPaths(dataDir, chatId).workspace, sandboxPath: request.path, ...defined({ caption: request.caption, kind: request.kind, replyToMessageId: request.reply_to_message_id, disableNotification: request.disable_notification }) }) };
    case "send_message": return { messageId: await sendTelegramRichMessage(bot, chatId, request) };
    case "send_location": return { messageId: await sendTelegramLocation(bot, chatId, request) };
    case "send_poll": { const sent = await sendTelegramPoll(bot, chatId, request); try { await recordPollOwner(dataDir, chatId, sent.pollId); } catch (error) { console.error("Failed to record poll ownership", error); } return sent; }
    case "stop_poll": return { messageId: request.message_id, data: await stopTelegramPoll(bot, chatId, request.message_id, request.reply_markup) };
    case "send_reaction": await sendTelegramReaction(bot, chatId, request.message_id, request.reaction); return undefined;
    case "edit_message": return { messageId: await sendTelegramEditMessage(bot, chatId, request) };
    case "delete_message": await deleteTelegramMessage(bot, chatId, request.message_id); return undefined;
    default: { const unhandled: never = request; void unhandled; throw new Error("Unhandled outbox request type"); }
  }
}


type WorkspaceFileRequest = {
  chatId: number;
  workspace: string;
  sandboxPath: string;
  caption?: string | undefined;
  kind?: WorkspaceOutboxFileKind;
  replyToMessageId?: number | undefined;
  disableNotification?: boolean | undefined;
};

const MAX_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;

const EXTENSION_KIND: Record<string, Exclude<WorkspaceOutboxFileKind, "auto" | "voice">> = {
  jpg: "photo", jpeg: "photo", png: "photo", gif: "photo", webp: "photo", bmp: "photo",
  mp3: "audio", m4a: "audio", aac: "audio", flac: "audio", wav: "audio", opus: "audio",
  mp4: "video", webm: "video", mkv: "video", mov: "video", avi: "video",
};

function resolvedFileKind(name: string, size: number, override: WorkspaceOutboxFileKind | undefined): Exclude<WorkspaceOutboxFileKind, "auto"> {
  const requested = override !== undefined && override !== "auto"
    ? override
    : EXTENSION_KIND[path.extname(name).slice(1).toLowerCase()];
  if (requested === undefined) return "document";
  // Telegram's photo upload cap is below the 20 MiB master cap; oversized images ship as documents.
  if (requested === "photo" && size > MAX_PHOTO_UPLOAD_BYTES) return "document";
  return requested;
}


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

export async function sendWorkspaceFile(bot: Bot, request: WorkspaceFileRequest): Promise<number> {
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
    const kind = resolvedFileKind(resolved, bytes.length, request.kind);

    const caption = request.caption === undefined
      ? undefined
      : Array.from(request.caption).slice(0, MAX_TELEGRAM_CAPTION_LENGTH).join("");

    const input = kind === "photo" ? new InputFile(bytes) : new InputFile(bytes, path.basename(resolved));
    const options = {
      ...(caption === undefined ? {} : { caption }),
      ...(request.replyToMessageId === undefined ? {} : { reply_to_message_id: request.replyToMessageId }),
      ...(request.disableNotification === undefined ? {} : { disable_notification: request.disableNotification }),
    };
    let sent: { message_id: number };
    if (kind === "photo") sent = await bot.api.sendPhoto(request.chatId, input, options);
    else if (kind === "audio") sent = await bot.api.sendAudio(request.chatId, input, options);
    else if (kind === "video") sent = await bot.api.sendVideo(request.chatId, input, options);
    else if (kind === "voice") sent = await bot.api.sendVoice(request.chatId, input, options);
    else sent = await bot.api.sendDocument(request.chatId, input, options);
    return sent.message_id;

  } finally {
    await handle.close();
  }
}
const POLL_OWNER_STORE_NAME = "poll-owners.jsonl";
const MAX_POLL_OWNER_LINES = 256;
const MAX_POLL_OWNER_BYTES = 64 * 1024;
const POLL_OWNER_CAPS = { maxLines: MAX_POLL_OWNER_LINES, maxBytes: MAX_POLL_OWNER_BYTES };

/** Records poll ownership in a host-side store the sandbox cannot reach (only /workspace is mounted). */
export async function recordPollOwner(dataDir: string, chatId: number, pollId: string): Promise<void> {
  await appendBoundedJsonl(
    path.join(dataDir, POLL_OWNER_STORE_NAME),
    JSON.stringify({ chatId, pollId }),
    POLL_OWNER_CAPS,
  );
}

/** Maps a poll id back to the chat that sent it via the host-side owner store. */
async function findPollOwnerChat(dataDir: string, pollId: string): Promise<number | undefined> {
  let lines: string[];
  try {
    lines = await readBoundedJsonl(path.join(dataDir, POLL_OWNER_STORE_NAME), POLL_OWNER_CAPS);
  } catch {
    return undefined;
  }
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    const candidate = record as Record<string, unknown>;
    if (candidate.pollId !== pollId) continue;
    if (typeof candidate.chatId !== "number" || !Number.isSafeInteger(candidate.chatId)) continue;
    return candidate.chatId;
  }
  return undefined;
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
  for (const segment of [ATTACHMENTS_DIR, date, String(messageId)]) {
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
        path: `/workspace/${ATTACHMENTS_DIR}/${date}/${message.message_id}/${filename}`,
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

async function prepareMessage(bot: Bot, config: Config, ctx: Context): Promise<SavedAttachment[]> {
  const message = ctx.message!;
  const source = attachmentSource(message);
  return source
    ? [await downloadAttachment(bot, config, ctx.chat!.id, message, source)]
    : [];
}

const ingressByBot = new WeakMap<Bot, TelegramIngressBuffer>();

export async function flushTelegramIngress(bot: Bot): Promise<void> {
  await ingressByBot.get(bot)?.flushAll();
}

export function closeTelegramIngress(bot: Bot): void {
  ingressByBot.get(bot)?.close();
}

/** Queues a host-side event into the bot's ingress buffer for delivery with the next flush. */
export function addTelegramIngressEvent(bot: Bot, chatId: number, event: ChatEvent): void {
  ingressByBot.get(bot)?.add(chatId, { value: Promise.resolve(event) });
}

/** Publishes the reduced command set to Telegram's client UI. */
export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: "status", description: "Show model, thinking level, and session summary" },
    { command: "start", description: "Introduction" },
  ]);
}


export function formatStatus(state: AgentStatus): string {
  const model = state.model ? `${state.model.provider}/${state.model.id}` : "unset";
  const session = state.sessionFile ?? "none";
  return `Model: ${model} | Thinking: ${state.thinkingLevel} | Session: ${session} | Messages: ${state.messageCount}`;
}

export function createTelegramBot(
  config: Config,
  agents: AgentManager,
  deliveryQueue: TelegramDeliveryQueue = new TelegramDeliveryQueue(),
): Bot {
  const bot = new Bot(config.token);

  const queuedReply = (ctx: Context, text: string) => deliveryQueue.enqueue(ctx.chat!.id, () => ctx.reply(text));

  const ingress = new TelegramIngressBuffer(async (chatId, events) => {
    const workspace = chatPaths(config.dataDir, chatId).workspace;
    await Promise.all(events.map((event) => appendChatEvent(workspace, event)));
    await agents.interrupt(chatId, WAKE_PROMPT).catch((error) => {
      console.error("Telegram wake prompt failed", error);
    });
  });
  ingressByBot.set(bot, ingress);

  bot.use(async (ctx, next) => {
    // grammY's ctx.from omits poll_answer updates; voters arrive in pollAnswer.user.
    const userId = ctx.from?.id ?? ctx.pollAnswer?.user?.id;
    if (userId === undefined || !config.allowedUserIds.has(userId)) {
      if (ctx.chat) await queuedReply(ctx, "Unauthorized.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await queuedReply(ctx, "Personal agent. Send text, attachments, or a location pin to continue your persistent session. /status shows the current model, thinking level, and session summary.");
  });

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat.id;
    let state: AgentStatus;
    try {
      state = await agents.status(chatId);
    } catch (error) {
      console.error("Failed to get status", error);
      await queuedReply(ctx, "I could not get the status. Please try again.");
      return;
    }
    await queuedReply(ctx, formatStatus(state));
  });

  bot.on("message", (ctx) => {
    const chatId = ctx.chat.id;
    let startPreparation!: () => void;
    const prepared = new Promise<ChatEvent>((resolve, reject) => {
      startPreparation = () => {
        void prepareMessage(bot, config, ctx).then(
          (attachments) => resolve({ type: "message", message: ctx.message, attachments }),
          reject,
        );
      };
    });
    const admission = ingress.add(chatId, {
      value: prepared,
      typing: async () => { await ctx.replyWithChatAction("typing"); },
    });
    if (admission) startPreparation();
  });
  bot.on("callback_query", (ctx) => {
    const query = ctx.callbackQuery;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    // Answer promptly so Telegram does not retry the update.
    void ctx.answerCallbackQuery().catch(() => {});
    ingress.add(chatId, {
      value: Promise.resolve({ type: "callback", callback_query: query }),
    });
  });
  bot.on("poll_answer", async (ctx) => {
    const answer = ctx.pollAnswer;
    const chatId = await findPollOwnerChat(config.dataDir, answer.poll_id);
    if (chatId === undefined) return;
    void appendChatEvent(chatPaths(config.dataDir, chatId).workspace, {
      type: "poll_answer",
      poll_answer: answer,
    });
  });

  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) console.error("Telegram API error", cause.description);
    else if (cause instanceof HttpError) console.error("Telegram transport error", cause);
    else console.error("Telegram update error", cause);
  });

  return bot;
}
