import { parseConfig, chatPaths } from "./config.js";
import { AgentManager } from "./agent.js";
import { WorkspaceOutbox } from "./outbox.js";
import { checkSandboxEnvironment, terminateActiveSandboxes } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { createTelegramBot, closeTelegramIngress, flushTelegramIngress, sendTelegramRichMessage, sendTelegramText, sendWorkspaceFile, TelegramDeliveryQueue } from "./telegram.js";
import { pathToFileURL } from "node:url";

export function isIntentionalSignalAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") return true;
  return candidate.message === "Aborted delay" || candidate.message === "This operation was aborted";
}

export interface DisposableServices {
  agents: Pick<AgentManager, "beginShutdown" | "disposeAll">;
  scheduler: Pick<WorkspaceScheduler, "stop">;
  outbox: Pick<WorkspaceOutbox, "stop">;
  delivery: Pick<TelegramDeliveryQueue, "drain">;
}

// Stops the scheduler and outbox, disposes agents, terminates sandboxes, and
// drains the delivery queue. Each step is guarded so a failure in one never
// skips the rest. Shared by the graceful shutdown() path (which overlaps
// beginShutdown with the ingress drain) and disposeServices() (which runs
// beginShutdown first).
async function finishDisposal(services: DisposableServices): Promise<void> {
  try {
    await services.scheduler.stop();
  } catch (error) {
    console.error("Scheduler shutdown failed", error);
  }
  try {
    await services.outbox.stop();
  } catch (error) {
    console.error("Outbox shutdown failed", error);
  }
  try {
    await services.agents.disposeAll(true);
  } catch (error) {
    console.error("Agent shutdown failed", error);
  }
  try {
    terminateActiveSandboxes();
  } catch (error) {
    console.error("Sandbox shutdown failed", error);
  }
  try {
    await services.delivery.drain();
  } catch (error) {
    console.error("Telegram delivery drain failed", error);
  }
}

export async function disposeServices(services: DisposableServices): Promise<void> {
  try {
    await services.agents.beginShutdown();
  } catch (error) {
    console.error("Agent abort failed", error);
  }
  await finishDisposal(services);
}

// Hoisted to module scope so the startup-failure path (main().catch) can reach
// and dispose them even after main() has rejected.
let agents: AgentManager | undefined;
let scheduler: WorkspaceScheduler | undefined;
let outbox: WorkspaceOutbox | undefined;
let delivery: TelegramDeliveryQueue | undefined;

export async function main(): Promise<void> {
  const config = parseConfig();
  const sandbox = await checkSandboxEnvironment(config.dataDir);
  const { dataDir, bwrapPath } = sandbox;
  const runtimeConfig = { ...config, dataDir };

  const agentManager = new AgentManager(runtimeConfig, { appRoot: process.cwd(), bwrapPath });
  const deliveryQueue = new TelegramDeliveryQueue();
  const bot = createTelegramBot(runtimeConfig, agentManager, deliveryQueue);
  const schedulerInstance = new WorkspaceScheduler({
    dataDir,
    run: (chatId, prompt) => agentManager.prompt(chatId, prompt, "follow-up"),
    send: async (chatId, text) => {
      if (text.trim().length > 0) {
        await deliveryQueue.enqueue(chatId, () => sendTelegramText(bot, chatId, text));
      }
    },
  });
  const outboxInstance = new WorkspaceOutbox({
    dataDir,
    dispatch: async (chatId, request) => {
      return deliveryQueue.enqueue(chatId, async () => {
        if (request.type === "send_file") {
          return sendWorkspaceFile(bot, {
            chatId,
            workspace: chatPaths(dataDir, chatId).workspace,
            sandboxPath: request.path,
            ...(request.caption === undefined ? {} : { caption: request.caption }),
          });
        }
        return sendTelegramRichMessage(bot, chatId, {
          text: request.text,
          ...(request.parse_mode === undefined ? {} : { parseMode: request.parse_mode }),
          ...(request.reply_markup === undefined ? {} : { replyMarkup: request.reply_markup }),
          ...(request.reply_to_message_id === undefined ? {} : { replyToMessageId: request.reply_to_message_id }),
        });
      });
    },
  });

  agents = agentManager;
  scheduler = schedulerInstance;
  outbox = outboxInstance;
  delivery = deliveryQueue;

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
      const agentShutdown = agentManager.beginShutdown().catch((error) => {
        console.error("Agent abort failed", error);
      });
      try {
        await flushTelegramIngress(bot);
      } catch (error) {
        console.error("Telegram ingress drain failed", error);
      }
      await agentShutdown;
      await finishDisposal({ agents: agentManager, scheduler: schedulerInstance, outbox: outboxInstance, delivery: deliveryQueue });
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  try {
    await schedulerInstance.start();
    if (shuttingDown) {
      await shutdown("startup interrupted");
      return;
    }
    await outboxInstance.start();
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
    if (shuttingDown && isIntentionalSignalAbort(error)) return;
    throw error;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(async (error) => {
    console.error("Fatal startup/polling failure", error);
    if (agents && scheduler && outbox && delivery) {
      await disposeServices({ agents, scheduler, outbox, delivery });
    }
    process.exitCode = 1;
  });
}
