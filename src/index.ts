import { parseConfig, chatPaths } from "./config.js";
import { AgentManager } from "./agent.js";
import { WorkspaceOutbox } from "./outbox.js";
import { checkSandboxEnvironment, terminateActiveSandboxes } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { createTelegramBot, closeTelegramIngress, flushTelegramIngress, sendTelegramText, sendWorkspaceFile, TelegramDeliveryQueue } from "./telegram.js";

async function main(): Promise<void> {
  const config = parseConfig();
  await checkSandboxEnvironment(config.dataDir);

  const agents = new AgentManager(config, { appRoot: process.cwd() });
  const delivery = new TelegramDeliveryQueue();
  let bot: ReturnType<typeof createTelegramBot>;
  const scheduler = new WorkspaceScheduler({
    dataDir: config.dataDir,
    run: (chatId, prompt) => agents.prompt(chatId, prompt, "follow-up"),
    send: async (chatId, text) => {
      if (text.trim().length > 0) {
        await delivery.enqueue(chatId, () => sendTelegramText(bot, chatId, text));
      }
    },
  });
  const outbox = new WorkspaceOutbox({
    dataDir: config.dataDir,
    sendFile: async (chatId, sandboxPath, caption) => {
      await delivery.enqueue(chatId, async () => {
        await sendWorkspaceFile(bot, {
          chatId,
          workspace: chatPaths(config.dataDir, chatId).workspace,
          sandboxPath,
          ...(caption === undefined ? {} : { caption }),
        });
      });
    },
  });

  bot = createTelegramBot(config, agents, delivery);

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      console.log(`Received ${signal}; shutting down`);
      try {
        await bot.stop();
      } catch (error) {
        console.error("Telegram stop failed", error);
      }
      closeTelegramIngress(bot);
      try {
        await flushTelegramIngress(bot);
      } catch (error) {
        console.error("Telegram ingress drain failed", error);
      }
      try {
        await agents.beginShutdown();
      } catch (error) {
        console.error("Agent abort failed", error);
      }
      try {
        await scheduler.stop();
      } catch (error) {
        console.error("Scheduler shutdown failed", error);
      }
      try {
        await outbox.stop();
      } catch (error) {
        console.error("Outbox shutdown failed", error);
      }
      try {
        await agents.disposeAll(true);
      } catch (error) {
        console.error("Agent shutdown failed", error);
      }
      try {
        terminateActiveSandboxes();
      } catch (error) {
        console.error("Sandbox shutdown failed", error);
      }
      try {
        await delivery.drain();
      } catch (error) {
        console.error("Telegram delivery drain failed", error);
      }
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  try {
    await scheduler.start();
    if (shuttingDown) {
      await shutdown("startup interrupted");
      return;
    }
    await outbox.start();
    if (shuttingDown) {
      await shutdown("startup interrupted");
      return;
    }
    console.log("Starting Telegram long polling");
    await bot.start({
      allowed_updates: ["message"],
      onStart: (info) => console.log(`Telegram bot @${info.username} started`),
    });
  } catch (error) {
    await shutdown("startup or polling failure");
    throw error;
  }
}

main().catch((error) => {
  console.error("Fatal startup/polling failure", error);
  try {
    terminateActiveSandboxes();
  } catch (terminationError) {
    console.error("Sandbox cleanup failed", terminationError);
  }
  process.exitCode = 1;
});
