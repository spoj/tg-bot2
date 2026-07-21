import { parseConfig } from "./config.js";
import { AgentManager } from "./agent.js";
import { checkSandboxEnvironment, terminateActiveSandboxes } from "./sandbox.js";
import { createTelegramBot, flushTelegramIngress } from "./telegram.js";

async function main(): Promise<void> {
  const config = parseConfig();
  await checkSandboxEnvironment(config.dataDir, { maxOutputBytes: config.maxToolOutputBytes });

  const agents = new AgentManager(config);
  const bot = createTelegramBot(config, agents);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    bot.stop();
    await flushTelegramIngress(bot);
    await agents.disposeAll(true);
    terminateActiveSandboxes();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("Starting Telegram long polling");
  await bot.start({
    allowed_updates: ["message"],
    onStart: (info) => console.log(`Telegram bot @${info.username} started`),
  });
}

main().catch((error) => {
  console.error("Fatal startup/polling failure", error);
  terminateActiveSandboxes();
  process.exitCode = 1;
});
