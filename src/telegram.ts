import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { Config } from "./config.js";
import type { AgentManager } from "./agent.js";

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

export function createTelegramBot(config: Config, agents: AgentManager): Bot {
  const bot = new Bot(config.token);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !config.allowedUserIds.has(userId)) {
      if (ctx.chat) await ctx.reply("Unauthorized.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply("Personal text agent. Send a message to continue your persistent session, or /new to start a fresh one.");
  });

  bot.command("new", async (ctx) => {
    try {
      await agents.newSession(ctx.chat.id);
      await ctx.reply("Started a new session. Earlier session files remain searchable.");
    } catch (error) {
      console.error("Failed to start new session", error);
      await ctx.reply("I could not start a new session. Please try again.");
    }
  });

  bot.on("message:text", async (ctx) => {
    try {
      await ctx.replyWithChatAction("typing");
      const typing = setInterval(() => void ctx.replyWithChatAction("typing").catch(() => {}), 4_000);
      typing.unref();
      try {
        const response = await agents.prompt(ctx.chat.id, ctx.message.text);
        await replyChunks(ctx, response);
      } finally {
        clearInterval(typing);
      }
    } catch (error) {
      console.error("Agent prompt failed", error);
      await ctx.reply("I could not complete that request. Please try again.");
    }
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("This version supports text messages only.");
  });

  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) console.error("Telegram API error", cause.description);
    else if (cause instanceof HttpError) console.error("Telegram transport error", cause);
    else console.error("Telegram update error", cause);
  });

  return bot;
}
