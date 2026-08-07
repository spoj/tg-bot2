import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "./config.js";
import { chatPaths } from "./config.js";
import type { AgentManager } from "./agent.js";

const INGRESS_COOLDOWN_MS = 2_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram Bot API download limit.

const MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_CAPTION_LENGTH = 1_024;

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

type BufferEntry = {
  value: Promise<BufferedTelegramMessage>;
  respond: (text: string) => Promise<void>;
  typing: () => Promise<void>;
};

type BufferState = {
  entries: BufferEntry[];
  timer: NodeJS.Timeout | undefined;
  inFlight: Set<Promise<void>>;
};

export class TelegramIngressBuffer {
  private closed = false;
  private readonly states = new Map<number, BufferState>();

  constructor(
    private readonly flushBatch: (chatId: number, messages: BufferedTelegramMessage[]) => Promise<string | undefined>,
    private readonly cooldownMs = INGRESS_COOLDOWN_MS,
  ) {}

  add(chatId: number, entry: BufferEntry): void {
    if (this.closed) return;
    let state = this.states.get(chatId);
    if (!state) {
      state = { entries: [], timer: undefined, inFlight: new Set() };
      this.states.set(chatId, state);
    }
    state.entries.push(entry);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.flush(chatId), this.cooldownMs);
    state.timer.unref();
  }

  async flush(chatId: number): Promise<void> {
    if (this.closed) return;
    const state = this.states.get(chatId);
    if (!state) return;
    if (state.entries.length === 0) {
      await Promise.allSettled([...state.inFlight]);
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    const entries = state.entries.splice(0);
    const current = (async () => {
      const latest = entries.at(-1)!;
      await latest.typing().catch(() => {});
      const typing = setInterval(() => void latest.typing().catch(() => {}), 4_000);
      typing.unref();
      try {
        const messages = await Promise.all(entries.map((entry) => entry.value));
        if (this.closed) return;
        const response = await this.flushBatch(chatId, messages);
        if (this.closed) return;
        if (response) await latest.respond(response);
      } catch (error) {
        console.error("Buffered Telegram request failed", error);
        if (!this.closed) await latest.respond("I could not complete that request. Please try again.").catch(() => {});
      } finally {
        clearInterval(typing);
      }
    })();
    state.inFlight.add(current);
    try {
      await current;
    } finally {
      state.inFlight.delete(current);
      if (state.entries.length === 0 && state.inFlight.size === 0) this.states.delete(chatId);
    }
  }

  close(): void {
    this.closed = true;
    for (const [chatId, state] of this.states) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      state.entries.splice(0);
      if (state.inFlight.size === 0) this.states.delete(chatId);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.allSettled([...this.states.keys()].map(async (chatId) => {
      await this.flush(chatId);
      const state = this.states.get(chatId);
      if (state) await Promise.allSettled([...state.inFlight]);
    }));
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
    else if (rest[cut] === "\n") cut += rest[cut + 1] === "\n" ? 2 : 1;
    else cut += 1;
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

  const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
    throw new Error("File does not exist.");
  });
  try {
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!isWithinWorkspace(workspace, openedPath)) throw new Error("File path resolves outside the workspace.");
    const file = await handle.stat();
    if (!file.isFile()) throw new Error("Path is not a regular file.");
    if (file.size > MAX_OUTBOUND_FILE_BYTES) throw new Error("File exceeds the 20 MiB upload limit.");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_OUTBOUND_FILE_BYTES) throw new Error("File exceeds the 20 MiB upload limit.");

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
  handle: Awaited<ReturnType<typeof open>>;
};

async function ensureAttachmentDirectory(workspace: string, date: string, messageId: number): Promise<AttachmentDirectory> {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const root = await realpath(workspace);
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
    return { path: `/proc/self/fd/${handle.fd}`, handle };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

function safeFilename(name: string | undefined, fallback: string): string {
  const base = path.basename(name?.trim() || fallback)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 160);
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
    const file = await bot.api.getFile(source.fileId);
    if (!file.file_path) return { ...common, failure: "Telegram did not provide a downloadable file path." };
    const response = await fetch(`https://api.telegram.org/file/bot${config.token}/${file.file_path}`);
    if (!response.ok) return { ...common, failure: `Telegram download failed with HTTP ${response.status}.` };
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
      return { ...common, failure: "Attachment exceeds Telegram's 20 MB bot download limit." };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return { ...common, failure: "Attachment exceeds Telegram's 20 MB bot download limit." };
    }
    const date = new Date(message.date * 1_000).toISOString().slice(0, 10);
    const workspace = chatPaths(config.dataDir, chatId).workspace;
    const attachmentDirectory = await ensureAttachmentDirectory(workspace, date, message.message_id);
    try {
      const filename = safeFilename(source.originalName, fallbackName(source, file.file_path));
      const directory = attachmentDirectory.path;
      const destination = path.join(directory, filename);
      const temporary = path.join(directory, `.${filename}.${randomUUID()}.part`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
      return {
        ...common,
        path: `/workspace/attachments/${date}/${message.message_id}/${filename}`,
      };
    } finally {
      await attachmentDirectory.handle.close();
    }
  } catch {
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

export function createTelegramBot(config: Config, agents: AgentManager): Bot {
  const bot = new Bot(config.token);

  agents.setAssistantProgress((chatId, text) => sendTelegramText(bot, chatId, text));
  const ingress = new TelegramIngressBuffer(async (chatId, messages) =>
    agents.prompt(chatId, formatBufferedPrompt(messages)));
  ingressByBot.set(bot, ingress);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !config.allowedUserIds.has(userId)) {
      if (ctx.chat) await ctx.reply("Unauthorized.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply("Personal agent. Send text or attachments to continue your persistent session, or /new to start a fresh one.");
  });

  bot.command("new", async (ctx) => {
    try {
      await ingress.flush(ctx.chat.id);
      await agents.newSession(ctx.chat.id);
      await ctx.reply("Started a new session. Earlier session files remain searchable.");
    } catch (error) {
      console.error("Failed to start new session", error);
      await ctx.reply("I could not start a new session. Please try again.");
    }
  });

  bot.on("message", async (ctx) => {
    const prepared = prepareMessage(bot, config, ctx);
    ingress.add(ctx.chat.id, {
      value: prepared,
      respond: (text) => replyChunks(ctx, text),
      typing: async () => { await ctx.replyWithChatAction("typing"); },
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
