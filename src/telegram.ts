import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import type { InputMediaPhoto, InputMediaVideo, Message, MessageEntity, Poll } from "grammy/types";
import type { Config } from "./config.js";
import type { AgentStatus } from "./agent.js";
import { WorkspaceEventLog } from "./events.js";
import { syncAllowlist } from "./allowlist.js";
import { botPaths, defined } from "./util.js";
import { SerialQueue } from "./queue.js";
import type {
  WorkspaceOutboxSendMessageRequest,
  WorkspaceOutboxSendMediaGroupRequest,
  WorkspaceOutboxSendLocationRequest,
  WorkspaceOutboxSendPollRequest,
  WorkspaceOutboxEditMessageRequest,
  WorkspaceOutboxCreateForumTopicRequest,
  WorkspaceOutboxEditForumTopicRequest,
  WorkspaceOutboxReaction,
  WorkspaceOutboxRequest,
  WorkspaceOutboxDispatchResult,
  WorkspaceOutboxFileKind,
} from "./outbox-protocol.js";

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
  const shared = defined({
    reply_to_message_id: request.reply_to_message_id,
    message_thread_id: request.message_thread_id,
    disable_notification: request.disable_notification,
  });
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
  const options = defined({
    is_anonymous: request.is_anonymous,
    allows_multiple_answers: request.allows_multiple_answers,
    type: request.poll_type,
    correct_option_id: request.correct_option_id,
    reply_to_message_id: request.reply_to_message_id,
    message_thread_id: request.message_thread_id,
    disable_notification: request.disable_notification,
  });
  const sent = await bot.api.sendPoll(chatId, request.question, request.options, options);
  return { messageId: sent.message_id, pollId: sent.poll.id };
}

export async function stopTelegramPoll(bot: Bot, chatId: number, messageId: number, replyMarkup?: unknown): Promise<Poll> {
  return bot.api.stopPoll(chatId, messageId, replyMarkup === undefined ? undefined : { reply_markup: replyMarkup as never });
}

export async function sendTelegramReaction(bot: Bot, chatId: number, messageId: number, reaction: WorkspaceOutboxReaction[]): Promise<void> {
  await bot.api.setMessageReaction(chatId, messageId, reaction as never);
}

/** Sends one rich message. */
export async function sendTelegramRichMessage(bot: Bot, chatId: number, request: WorkspaceOutboxSendMessageRequest): Promise<number> {
  const sent = await bot.api.sendMessage(
    chatId,
    request.text,
    defined({
      parse_mode: request.parse_mode,
      reply_markup: request.reply_markup as never,
      reply_to_message_id: request.reply_to_message_id,
      message_thread_id: request.message_thread_id,
      entities: request.entities as never,
      link_preview_options: request.link_preview_options as never,
      disable_notification: request.disable_notification,
    }),
  );
  return sent.message_id;
}

/** Edits one message. */
export async function sendTelegramEditMessage(bot: Bot, chatId: number, request: WorkspaceOutboxEditMessageRequest): Promise<number> {
  const sent = await bot.api.editMessageText(
    chatId,
    request.message_id,
    request.text,
    defined({
      parse_mode: request.parse_mode,
      entities: request.entities as never,
      link_preview_options: request.link_preview_options as never,
      reply_markup: request.reply_markup as never,
    }),
  ) as { message_id: number };
  return sent.message_id;
}
export async function deleteTelegramMessage(bot: Bot, chatId: number, messageId: number): Promise<void> {
  await bot.api.deleteMessage(chatId, messageId);
}

export async function createTelegramForumTopic(bot: Bot, chatId: number, request: WorkspaceOutboxCreateForumTopicRequest): Promise<{ messageThreadId: number; data: unknown }> {
  const options = defined({ icon_color: request.icon_color as never, icon_custom_emoji_id: request.icon_custom_emoji_id });
  const topic = await bot.api.createForumTopic(chatId, request.name, options);
  return { messageThreadId: topic.message_thread_id, data: topic };
}

export async function editTelegramForumTopic(bot: Bot, chatId: number, request: WorkspaceOutboxEditForumTopicRequest): Promise<{ messageThreadId: number }> {
  const options = defined({ name: request.name, icon_custom_emoji_id: request.icon_custom_emoji_id });
  await bot.api.editForumTopic(chatId, request.message_thread_id, options);
  return { messageThreadId: request.message_thread_id };
}

export async function closeTelegramForumTopic(bot: Bot, chatId: number, messageThreadId: number): Promise<{ messageThreadId: number }> {
  await bot.api.closeForumTopic(chatId, messageThreadId);
  return { messageThreadId };
}

export async function reopenTelegramForumTopic(bot: Bot, chatId: number, messageThreadId: number): Promise<{ messageThreadId: number }> {
  await bot.api.reopenForumTopic(chatId, messageThreadId);
  return { messageThreadId };
}

export async function deleteTelegramForumTopic(bot: Bot, chatId: number, messageThreadId: number): Promise<{ messageThreadId: number }> {
  await bot.api.deleteForumTopic(chatId, messageThreadId);
  return { messageThreadId };
}

export async function unpinAllTelegramForumTopicMessages(bot: Bot, chatId: number, messageThreadId: number): Promise<{ messageThreadId: number }> {
  await bot.api.unpinAllForumTopicMessages(chatId, messageThreadId);
  return { messageThreadId };
}

export async function dispatchOutboxRequest(bot: Bot, paths: { botDir: string; workspace: string }, chatId: number, request: WorkspaceOutboxRequest): Promise<WorkspaceOutboxDispatchResult | undefined> {
  switch (request.type) {
    case "send_file": return { messageId: await sendWorkspaceFile(bot, { chatId, workspace: paths.workspace, sandboxPath: request.path, ...defined({ caption: request.caption, kind: request.kind, replyToMessageId: request.reply_to_message_id, messageThreadId: request.message_thread_id, disableNotification: request.disable_notification }) }) };
    case "send_message": return { messageId: await sendTelegramRichMessage(bot, chatId, request) };
    case "send_media_group": return { messageId: await sendTelegramMediaGroup(bot, { chatId, workspace: paths.workspace, request }) };
    case "send_location": return { messageId: await sendTelegramLocation(bot, chatId, request) };
    case "send_poll": return sendTelegramPoll(bot, chatId, request);
    case "stop_poll": return { messageId: request.message_id, data: await stopTelegramPoll(bot, chatId, request.message_id, request.reply_markup) };
    case "send_reaction": await sendTelegramReaction(bot, chatId, request.message_id, request.reaction); return undefined;
    case "edit_message": return { messageId: await sendTelegramEditMessage(bot, chatId, request) };
    case "delete_message": await deleteTelegramMessage(bot, chatId, request.message_id); return undefined;
    case "create_forum_topic": {
      const created = await createTelegramForumTopic(bot, chatId, request);
      return { messageThreadId: created.messageThreadId, data: created.data };
    }
    case "edit_forum_topic": return editTelegramForumTopic(bot, chatId, request);
    case "close_forum_topic": return closeTelegramForumTopic(bot, chatId, request.message_thread_id);
    case "reopen_forum_topic": return reopenTelegramForumTopic(bot, chatId, request.message_thread_id);
    case "delete_forum_topic": return deleteTelegramForumTopic(bot, chatId, request.message_thread_id);
    case "unpin_all_forum_topic_messages": return unpinAllTelegramForumTopicMessages(bot, chatId, request.message_thread_id);
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
  messageThreadId?: number | undefined;
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

async function workspaceFileInput(workspace: string, sandboxPath: string): Promise<{ bytes: Buffer; resolved: string }> {
  const candidate = workspaceCandidate(workspace, sandboxPath);
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
    return { bytes: Buffer.concat(chunks, total), resolved };
  } finally {
    await handle.close();
  }
}

function boundedCaption(caption: string | undefined): string | undefined {
  return caption === undefined
    ? undefined
    : Array.from(caption).slice(0, MAX_TELEGRAM_CAPTION_LENGTH).join("");
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

  const { bytes, resolved } = await workspaceFileInput(workspace, request.sandboxPath);
  const kind = resolvedFileKind(resolved, bytes.length, request.kind);
  const caption = boundedCaption(request.caption);
  const input = kind === "photo" ? new InputFile(bytes) : new InputFile(bytes, path.basename(resolved));
  const options = {
    ...(caption === undefined ? {} : { caption }),
    ...(request.replyToMessageId === undefined ? {} : { reply_to_message_id: request.replyToMessageId }),
    ...(request.messageThreadId === undefined ? {} : { message_thread_id: request.messageThreadId }),
    ...(request.disableNotification === undefined ? {} : { disable_notification: request.disableNotification }),
  };
  let sent: { message_id: number };
  if (kind === "photo") sent = await bot.api.sendPhoto(request.chatId, input, options);
  else if (kind === "audio") sent = await bot.api.sendAudio(request.chatId, input, options);
  else if (kind === "video") sent = await bot.api.sendVideo(request.chatId, input, options);
  else if (kind === "voice") sent = await bot.api.sendVoice(request.chatId, input, options);
  else sent = await bot.api.sendDocument(request.chatId, input, options);
  return sent.message_id;
}
export async function sendTelegramMediaGroup(bot: Bot, request: { chatId: number; workspace: string; request: WorkspaceOutboxSendMediaGroupRequest }): Promise<number> {
  const { chatId } = request;
  let workspace: string;
  try {
    workspace = await realpath(request.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace is not a directory.");
  } catch (error) {
    if (error instanceof Error && error.message === "Workspace is not a directory.") throw error;
    throw new Error("Workspace is unavailable.");
  }
  const group: Array<InputMediaPhoto | InputMediaVideo> = [];
  for (const item of request.request.media) {
    const { bytes, resolved } = await workspaceFileInput(workspace, item.media);
    if (item.type === "photo") {
      group.push({
        type: "photo",
        media: new InputFile(bytes),
        ...defined({
          caption: boundedCaption(item.caption),
          parse_mode: item.parse_mode,
          caption_entities: item.caption_entities as MessageEntity[] | undefined,
          show_caption_above_media: item.show_caption_above_media,
          has_spoiler: item.has_spoiler,
        }),
      });
    } else {
      group.push({
        type: "video",
        media: new InputFile(bytes, path.basename(resolved)),
        ...defined({
          caption: boundedCaption(item.caption),
          parse_mode: item.parse_mode,
          caption_entities: item.caption_entities as MessageEntity[] | undefined,
          show_caption_above_media: item.show_caption_above_media,
          has_spoiler: item.has_spoiler,
          width: item.width,
          height: item.height,
          duration: item.duration,
          supports_streaming: item.supports_streaming,
        }),
      });
    }
  }
  const options = {
    ...(request.request.reply_to_message_id === undefined ? {} : { reply_to_message_id: request.request.reply_to_message_id }),
    ...(request.request.message_thread_id === undefined ? {} : { message_thread_id: request.request.message_thread_id }),
    ...(request.request.disable_notification === undefined ? {} : { disable_notification: request.request.disable_notification }),
  };
  const sent = await bot.api.sendMediaGroup(chatId, group, options);
  const first = sent[0];
  if (!first) throw new Error("Telegram returned an empty media group");
  return first.message_id;
}
/** Maps a poll id back to the chat that sent it via events.jsonl. */
export async function findPollOwnerChat(workspace: string, pollId: string, events?: WorkspaceEventLog): Promise<number | undefined> {
  const eventLog = events ?? new WorkspaceEventLog(workspace);
  const record = await eventLog.findLast((entry) => entry.type === "outbox_sent" && "pollId" in entry && entry.pollId === pollId && "chat_id" in entry && typeof entry.chat_id === "number");
  if (record && record.type === "outbox_sent") {
    return record.chat_id;
  }
  return undefined;
}
type AttachmentDirectory = {
  path: string;
  expectedPath: string;
  handle: Awaited<ReturnType<typeof open>>;
};

async function ensureAttachmentDirectory(workspace: string, chatId: number, date: string, messageId: number): Promise<AttachmentDirectory> {
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
  for (const segment of [ATTACHMENTS_DIR, String(chatId), date, String(messageId)]) {
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
    const { workspace } = botPaths(config.dataDir, config.botId);
    const attachmentDirectory = await ensureAttachmentDirectory(workspace, chatId, date, message.message_id);
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
        path: `/workspace/${ATTACHMENTS_DIR}/${chatId}/${date}/${message.message_id}/${filename}`,
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
  const parts = [
    `Model: ${model}`,
    `Thinking: ${state.thinkingLevel}`,
    `Session: ${session}`,
    `Messages: ${state.messageCount}`,
  ];
  if (state.activeTasks !== undefined && state.activeTasks > 0) {
    parts.push(`Tasks: ${state.activeTasks}`);
  }
  if (state.activeSchedules !== undefined && state.activeSchedules > 0) {
    parts.push(`Schedules: ${state.activeSchedules}`);
  }
  return parts.join(" | ");
}

type TelegramChatInfo = {
  id: number;
  title?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
};

function chatTitle(chat: TelegramChatInfo): string | undefined {
  const title = chat.title?.trim();
  if (title) return title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  return name || undefined;
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

async function isChatAllowed(workspace: string, chatId: number, events?: WorkspaceEventLog): Promise<boolean> {
  const allowed = await syncAllowlist(workspace, events);
  return allowed !== null && allowed.includes(chatId);
}

export const KNOCK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown per unknown chat

export async function shouldNotifyKnock(workspace: string, chatId: number, now = Date.now(), events?: WorkspaceEventLog): Promise<boolean> {
  if (chatId <= 0) return false;
  const eventLog = events ?? new WorkspaceEventLog(workspace);
  const record = await eventLog.findLast((entry) => entry.type === "chat_denied" && "chat_id" in entry && entry.chat_id === chatId && typeof entry.t === "string");
  if (record && typeof record.t === "string") {
    const lastTime = new Date(record.t).getTime();
    if (!Number.isNaN(lastTime) && now - lastTime < KNOCK_COOLDOWN_MS) {
      return false;
    }
  }
  return true;
}

/**
 * The ingress gate: allowed chats pass; everything else is denied with a chat_denied
 * audit event and no reply. A missing or malformed allow list fails closed.
 */
async function gateChat(workspace: string, events: WorkspaceEventLog, chat: TelegramChatInfo): Promise<boolean> {
  const chatId = chat.id;
  if (!Number.isSafeInteger(chatId)) return false;

  const allowed = await syncAllowlist(workspace, events);
  if (allowed && allowed.includes(chatId)) {
    return true;
  }

  await events.publish({
    type: "chat_denied",
    chat_id: chatId,
    ...defined({ title: chatTitle(chat) }),
  });
  return false;
}
export function createTelegramBot(
  config: Config,
  events: WorkspaceEventLog,
  deliveryQueue: TelegramDeliveryQueue = new TelegramDeliveryQueue(),
  statusProvider?: { status(): Promise<AgentStatus> },
): Bot {
  const bot = new Bot(config.token);
  const { workspace } = botPaths(config.dataDir, config.botId);

  const queuedReply = (ctx: Context, text: string) => deliveryQueue.enqueue(ctx.chat!.id, () => ctx.reply(text));

  bot.use(async (ctx, next) => {
    // poll_answer updates carry no chat; their handler routes and gates them.
    const chat = ctx.chat;
    if (!chat) {
      await next();
      return;
    }
    if (!(await gateChat(workspace, events, chat))) return;
    await next();
  });

  bot.command("start", async (ctx) => {
    await queuedReply(ctx, "Personal agent. Send text, attachments, or a location pin to continue your persistent session. /status shows the current model, thinking level, and session summary.");
  });

  bot.command("status", async (ctx) => {
    if (!statusProvider) {
      await queuedReply(ctx, "Status is not available.");
      return;
    }
    let state: AgentStatus;
    try {
      state = await statusProvider.status();
    } catch (error) {
      console.error("Failed to get status", error);
      await queuedReply(ctx, "I could not get the status. Please try again.");
      return;
    }
    await queuedReply(ctx, formatStatus(state));
  });

  bot.on("message", async (ctx) => {
    const chatId = ctx.chat.id;
    const attachments = await prepareMessage(bot, config, ctx);
    await events.publish({ type: "message", chat_id: chatId, message: ctx.message, attachments });
  });
  bot.on("callback_query", async (ctx) => {
    const query = ctx.callbackQuery;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    // Answer promptly so Telegram does not retry the update.
    void ctx.answerCallbackQuery().catch(() => {});
    await events.emit({ type: "callback", chat_id: chatId, callback_query: query });
  });
  bot.on("poll_answer", async (ctx) => {
    const answer = ctx.pollAnswer;
    const chatId = await findPollOwnerChat(workspace, answer.poll_id);
    if (chatId === undefined) return;
    if (!(await isChatAllowed(workspace, chatId, events))) return;
    await events.emit({
      type: "poll_answer",
      chat_id: chatId,
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
