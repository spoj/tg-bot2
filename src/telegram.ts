import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "./config.js";
import { WorkspaceTimeline } from "./events.js";
import { readAllowedFile } from "./allowlist.js";
import { botPaths } from "./util.js";
import { SerialQueue } from "./queue.js";
import type { WorkspaceOutboxRequest, WorkspaceOutboxDispatchResult } from "./outbox-protocol.js";

const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram Bot API download limit for incoming attachments (20 MiB).

const MAX_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024;
const OUTBOUND_READ_CHUNK_BYTES = 64 * 1024;
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



const MEDIA_FIELDS: Partial<Record<WorkspaceOutboxRequest["method"], string>> = {
  sendPhoto: "photo", sendAudio: "audio", sendVideo: "video", sendAnimation: "animation",
  sendVoice: "voice", sendVideoNote: "video_note", sendDocument: "document",
};

function telegramPayload(request: WorkspaceOutboxRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...request };
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

async function readLocalFile(root: string, exposedPath: string, mountPoint: string): Promise<{ bytes: Buffer; resolved: string }> {
  const candidate = exposedCandidate(root, exposedPath, mountPoint);
  if (!isWithinRoot(root, candidate)) throw new Error(`Local file escapes ${mountPoint}`);
  const resolved = await realpath(candidate).catch(() => { throw new Error("Local file does not exist"); });
  if (!isWithinRoot(root, resolved)) throw new Error(`Local file resolves outside ${mountPoint}`);
  const handle = await open(resolved, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING).catch(() => { throw new Error("Local file does not exist"); });
  try {
    const file = await handle.stat();
    if (!file.isFile()) throw new Error("Local path is not a regular file");
    if (file.size > MAX_OUTBOUND_FILE_BYTES) throw new Error(`Local file exceeds ${MAX_OUTBOUND_FILE_BYTES} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_OUTBOUND_FILE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(OUTBOUND_READ_CHUNK_BYTES, MAX_OUTBOUND_FILE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_OUTBOUND_FILE_BYTES) throw new Error(`Local file exceeds ${MAX_OUTBOUND_FILE_BYTES} bytes`);
    return { bytes: Buffer.concat(chunks, total), resolved };
  } finally {
    await handle.close();
  }
}

async function stageOutboundFile(
  paths: { workspace: string; attachments: string }, chatId: number, requestId: string, exposedPath: string, index?: number,
): Promise<{ path: string; input: InputFile }> {
  const alreadyManaged = exposedPath.startsWith("/run/attachments/");
  const source = await readLocalFile(
    alreadyManaged ? paths.attachments : paths.workspace,
    exposedPath,
    alreadyManaged ? "/run/attachments" : "/workspace",
  );
  if (alreadyManaged) return { path: exposedPath, input: new InputFile(source.bytes, path.basename(source.resolved)) };

  const date = new Date().toISOString().slice(0, 10);
  const directory = await ensureAttachmentDirectory(paths.attachments, chatId, date, requestId);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const base = safeFilename(path.basename(source.resolved), "file.bin");
    const filename = index === undefined ? base : `${index + 1}-${base}`;
    const destination = path.join(directory.path, filename);
    try {
      handle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, 0o600);
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
      path: `/run/attachments/${chatId}/${date}/${requestId}/${filename}`,
      input: new InputFile(source.bytes, filename),
    };
  } finally {
    await handle?.close().catch(() => {});
    await directory.handle.close();
  }
}

async function prepareTelegramPayload(
  paths: { workspace: string; attachments: string }, chatId: number, requestId: string, request: WorkspaceOutboxRequest,
): Promise<{ payload: Record<string, unknown>; recorded: WorkspaceOutboxRequest; attachmentPaths: string[] }> {
  const payload = telegramPayload(request);
  const recorded = structuredClone(request);
  const attachmentPaths: string[] = [];
  const field = MEDIA_FIELDS[request.method];
  if (field !== undefined && typeof payload[field] === "string" && (payload[field] as string).startsWith("/")) {
    const staged = await stageOutboundFile(paths, chatId, requestId, payload[field] as string);
    payload[field] = staged.input;
    recorded[field] = staged.path;
    attachmentPaths.push(staged.path);
  }
  if (request.method === "sendMediaGroup" && Array.isArray(payload.media)) {
    const recordedMedia = recorded.media as Array<Record<string, unknown>>;
    payload.media = await Promise.all(payload.media.map(async (item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      const copy = { ...(item as Record<string, unknown>) };
      if (typeof copy.media === "string" && copy.media.startsWith("/")) {
        const staged = await stageOutboundFile(paths, chatId, requestId, copy.media, index);
        copy.media = staged.input;
        recordedMedia[index] = { ...(recordedMedia[index] ?? {}), media: staged.path };
        attachmentPaths.push(staged.path);
      }
      return copy;
    }));
  }
  return { payload, recorded, attachmentPaths };
}

function dispatchResult(data: unknown, request: WorkspaceOutboxRequest, attachmentPaths: string[]): WorkspaceOutboxDispatchResult {
  const result = data !== null && typeof data === "object" ? data as Record<string, unknown> : {};
  const poll = result.poll !== null && typeof result.poll === "object" ? result.poll as Record<string, unknown> : undefined;
  return {
    request,
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
    ...(typeof result.message_id === "number" ? { messageId: result.message_id } : {}),
    ...(typeof poll?.id === "string" ? { pollId: poll.id } : {}),
    ...(typeof result.message_thread_id === "number" ? { messageThreadId: result.message_thread_id } : {}),
    data,
  };
}

export async function dispatchOutboxRequest(
  bot: Bot,
  paths: { workspace: string; attachments: string },
  chatId: number,
  requestId: string,
  request: WorkspaceOutboxRequest,
): Promise<WorkspaceOutboxDispatchResult> {
  const { payload, recorded, attachmentPaths } = await prepareTelegramPayload(paths, chatId, requestId, request);
  const raw = bot.api.raw as unknown as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;
  const call = raw[request.method];
  if (!call) throw new Error(`Telegram Bot API method is unavailable: ${request.method}`);
  const data = await call(payload);
  if (request.topic_name !== undefined && request.message_thread_id !== undefined) {
    try {
      await raw.editForumTopic?.({ chat_id: chatId, message_thread_id: request.message_thread_id, name: request.topic_name });
    } catch (error) {
      console.error("Incidental topic rename failed", error);
    }
  }
  return dispatchResult(data, recorded, attachmentPaths);
}
type AttachmentDirectory = {
  path: string;
  expectedPath: string;
  handle: Awaited<ReturnType<typeof open>>;
};

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
    const { attachments } = botPaths(config.dataDir, config.botId);
    const attachmentDirectory = await ensureAttachmentDirectory(attachments, chatId, date, message.message_id);
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
        path: `/run/attachments/${chatId}/${date}/${message.message_id}/${filename}`,
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
  const message = ctx.msg;
  if (!message) return [];
  const source = attachmentSource(message);
  return source
    ? [await downloadAttachment(bot, config, ctx.chat!.id, message, source)]
    : [];
}



/** Publishes the reduced command set to Telegram's client UI. */
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

/** The ingress gate. Missing, malformed, and non-matching allow lists fail closed. */
async function gateChat(workspace: string, chat: { id: number }): Promise<boolean> {
  const chatId = chat.id;
  return Number.isSafeInteger(chatId) && await isChatAllowed(workspace, chatId);
}
type AgentHostAccess = { restartAll(): Promise<void> };

export function createTelegramBot(
  config: Config,
  timeline: WorkspaceTimeline,
  deliveryQueue: TelegramDeliveryQueue = new TelegramDeliveryQueue(),
  agent?: AgentHostAccess,
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
    // A bot added to a brand-new group must reach the agent so it can decide whether to
    // allow the group, even before the chat is allowlisted. Messages from that group stay
    // gated until the agent allowlists it.
    if (chat.id < 0 && ctx.myChatMember && isBotGroupAdd(ctx.myChatMember) && !(await isChatAllowed(workspace, chat.id))) {
      await next();
      return;
    }
    if (!(await gateChat(workspace, chat))) return;
    await next();
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

  bot.on("message", async (ctx) => {
    const chatId = ctx.chat.id;
    const attachments = await prepareMessage(bot, config, ctx);
    await timeline.publish({ type: "message", chat_id: chatId, message: ctx.message, attachments });
  });
  bot.on("edited_message", async (ctx) => {
    const chatId = ctx.chat.id;
    const attachments = await prepareMessage(bot, config, ctx);
    await timeline.publish({ type: "edited_message", chat_id: chatId, message: ctx.editedMessage, attachments });
  });
  bot.on("callback_query", async (ctx) => {
    const query = ctx.callbackQuery;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    void ctx.answerCallbackQuery().catch(() => {});
    await timeline.publish({ type: "callback", chat_id: chatId, callback_query: query });
  });
  bot.on("poll_answer", async (ctx) => {
    const answer = ctx.pollAnswer;
    const owner = timeline.pollOwner(answer.poll_id);
    if (owner === undefined || !(await isChatAllowed(workspace, owner.chatId))) return;
    await timeline.publish({ type: "poll_answer", chat_id: owner.chatId, poll_answer: answer });
  });
  bot.on("message_reaction", async (ctx) => {
    const reaction = ctx.messageReaction;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    await timeline.publish({ type: "message_reaction", chat_id: chatId, message_reaction: reaction });
  });
  bot.on("my_chat_member", async (ctx) => {
    const member = ctx.myChatMember;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    await timeline.publish({ type: "my_chat_member", chat_id: chatId, my_chat_member: member });
  });
  bot.on("chat_join_request", async (ctx) => {
    const request = ctx.chatJoinRequest;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    await timeline.publish({ type: "chat_join_request", chat_id: chatId, chat_join_request: request });
  });

  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) console.error("Telegram API error", cause.description);
    else if (cause instanceof HttpError) console.error("Telegram transport error", cause);
    else console.error("Telegram update error", cause);
  });

  return bot;
}
