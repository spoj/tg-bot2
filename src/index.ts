import { parseConfig, chatPaths } from "./config.js";
import { AgentManager } from "./agent.js";
import { checkSandboxEnvironment, terminateActiveSandboxes } from "./sandbox.js";
import { createTelegramBot, closeTelegramIngress, sendTelegramText, sendWorkspaceFile } from "./telegram.js";
import { Scheduler } from "./scheduler.js";
import type { ToolHandlers } from "./tools.js";

async function main(): Promise<void> {
  const config = parseConfig();
  await checkSandboxEnvironment(config.dataDir, { maxOutputBytes: config.maxToolOutputBytes });

  // Construct the scheduler before any chat session can be created. Its callbacks
  // receive trusted chat IDs from the AgentManager/tool boundary, never from the model.
  let bot: ReturnType<typeof createTelegramBot>;
  const agentRef: { current?: AgentManager } = {};
  const scheduler = new Scheduler({
    dataDir: config.dataDir,
    run: async (chatId, prompt) => {
      const agents = agentRef.current;
      if (!agents) throw new Error("Agent manager is not ready");
      return (await agents.prompt(chatId, prompt, "follow-up")) ?? "";
    },
    send: async (chatId, text) => sendTelegramText(bot, chatId, text),
  });
  const toolHandlers: ToolHandlers = {
    sendFile: (chatId, sandboxPath, caption) => sendWorkspaceFile(bot, {
      chatId,
      workspace: chatPaths(config.dataDir, chatId).workspace,
      sandboxPath,
      ...(caption === undefined ? {} : { caption }),
    }),
    schedule: (chatId, request) => scheduler.schedule(chatId, request),
    listSchedules: (chatId) => scheduler.list(chatId),
    cancelSchedule: (chatId, id) => scheduler.cancel(chatId, id),
  };
  const agents = new AgentManager(config, undefined, { toolHandlers });
  agentRef.current = agents;
  bot = createTelegramBot(config, agents);

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
      const schedulerStopped = scheduler.stop();
      await Promise.allSettled([agents.disposeAll(true), schedulerStopped]);
      terminateActiveSandboxes();
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  try {
    await scheduler.start();
  } catch (error) {
    await shutdown("startup failure");
    throw error;
  }
  if (shuttingDown) return;

  console.log("Starting Telegram long polling");
  try {
    await bot.start({
      allowed_updates: ["message"],
      onStart: (info) => console.log(`Telegram bot @${info.username} started`),
    });
  } catch (error) {
    await shutdown("polling failure");
    throw error;
  }
}

main().catch((error) => {
  console.error("Fatal startup/polling failure", error);
  terminateActiveSandboxes();
  process.exitCode = 1;
});
