import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "./config.js";
import { chatPaths } from "./config.js";
import type { AgentManager } from "./agent.js";

const INGRESS_COOLDOWN_MS = 2_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram Bot API download limit.

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
  private readonly states = new Map<number, BufferState>();

  constructor(
    private readonly flushBatch: (chatId: number, messages: BufferedTelegramMessage[]) => Promise<string | undefined>,
    private readonly cooldownMs = INGRESS_COOLDOWN_MS,
  ) {}

  add(chatId: number, entry: BufferEntry): void {
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
        const response = await this.flushBatch(chatId, messages);
        if (response) await latest.respond(response);
      } catch (error) {
        console.error("Buffered Telegram request failed", error);
        await latest.respond("I could not complete that request. Please try again.").catch(() => {});
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
    const directory = path.join(workspace, "attachments", date, String(message.message_id));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = safeFilename(source.originalName, fallbackName(source, file.file_path));
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

export function createTelegramBot(config: Config, agents: AgentManager): Bot {
  const bot = new Bot(config.token);
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
