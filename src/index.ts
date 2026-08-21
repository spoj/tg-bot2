import { loadConfig, type BotConfig } from "./config.js";
import { AgentManager } from "./agent.js";
import { WorkspaceOutbox } from "./outbox.js";
import { checkSandboxEnvironment, spawnProcess, terminateActiveSandboxes, terminateProcessGroup } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { WorkspaceRequestBus } from "./request-bus.js";
import { WorkspaceTasks } from "./task.js";
import type { Bot } from "grammy";
import { HostBrowserManager } from "./browser.js";
import { createTelegramBot, dispatchOutboxRequest, registerBotCommands, TelegramDeliveryQueue } from "./telegram.js";
import { EventSink } from "./events.js";
import { botPaths } from "./util.js";
import { pathToFileURL } from "node:url";

export function isIntentionalSignalAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") return true;
  return candidate.message === "Aborted delay" || candidate.message === "This operation was aborted";
}

export interface DisposableServices {
  agents: Pick<AgentManager, "disposeAll">;
  scheduler: Pick<WorkspaceScheduler, "stop">;
  requestBus: Pick<WorkspaceRequestBus, "stop">;
  tasks: Pick<WorkspaceTasks, "stop">;
  delivery: Pick<TelegramDeliveryQueue, "drain">;
  browser?: Pick<HostBrowserManager, "stop">;
}

export interface BotInstance {
  config: BotConfig;
  paths: { botDir: string; workspace: string };
  bot: Bot;
  agents: AgentManager;
  scheduler: WorkspaceScheduler;
  requestBus: WorkspaceRequestBus;
  tasks: WorkspaceTasks;
  delivery: TelegramDeliveryQueue;
  browser: HostBrowserManager;
}

// Stops the scheduler, request bus, and tasks, disposes agents, terminates
// sandboxes, and drains the delivery queue. Each step is guarded so a failure
// in one never skips the rest.
export async function finishDisposal(services: DisposableServices): Promise<void> {
  try {
    await services.scheduler.stop();
  } catch (error) {
    console.error("Scheduler shutdown failed", error);
  }
  try {
    await services.requestBus.stop();
  } catch (error) {
    console.error("Request bus shutdown failed", error);
  }
  try {
    await services.tasks.stop();
  } catch (error) {
    console.error("Task shutdown failed", error);
  }
  try {
    await services.agents.disposeAll();
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
  if (services.browser) {
    try {
      await services.browser.stop();
    } catch (error) {
      console.error("Browser shutdown failed", error);
    }
  }
}

export async function main(): Promise<void> {
  const config = await loadConfig();
  const sandbox = await checkSandboxEnvironment(config.dataDir);
  const { dataDir, bwrapPath } = sandbox;

  const instances: BotInstance[] = config.bots.map((botConfig) => {
    const paths = botPaths(dataDir, botConfig.botId);
    const { workspace } = paths;
    const runtimeConfig = { ...botConfig, dataDir, ...paths };

    const agentManager = new AgentManager({ workspace }, { appRoot: process.cwd(), bwrapPath, spawnProcess, terminateProcessGroup });
    const eventSink = new EventSink(workspace, agentManager);
    const deliveryQueue = new TelegramDeliveryQueue();
    const bot = createTelegramBot(runtimeConfig, eventSink, deliveryQueue, agentManager);
    const schedulerInstance = new WorkspaceScheduler({
      workspace,
      events: eventSink,
    });
    const outboxInstance = new WorkspaceOutbox({
      workspace,
      events: eventSink,
      dispatch: (chatId, request) => deliveryQueue.enqueue(chatId, () => dispatchOutboxRequest(bot, paths, chatId, request)),
    });
    const tasksInstance = new WorkspaceTasks({
      workspace,
      events: eventSink,
      appRoot: process.cwd(),
      bwrapPath,
      spawnProcess,
      terminateProcessGroup,
    });
    const browserManager = new HostBrowserManager({ workspace, events: eventSink });
    const requestBus = new WorkspaceRequestBus({
      workspace,
      onSend: (record, ws) => outboxInstance.handleSendRequest(record, ws),
      onSpawn: (record, ws) => tasksInstance.handleSpawnRequest(record, ws),
      onCancel: (record, ws) => tasksInstance.handleCancelRequest(record, ws),
      onStartBrowser: (record) => browserManager.handleStartBrowserRequest(record).then(() => {}),
    });
    tasksInstance.flush = requestBus;
    return {
      config: runtimeConfig,
      paths,
      bot,
      agents: agentManager,
      scheduler: schedulerInstance,
      requestBus,
      tasks: tasksInstance,
      delivery: deliveryQueue,
      browser: browserManager,
    };
  });

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      console.log(`Received ${signal}; shutting down`);
      for (const instance of instances) {
        try {
          await instance.bot.stop();
        } catch (error) {
          console.error(`Telegram stop failed for bot ${instance.config.botId}`, error);
        }
      }
      for (const instance of instances) {
        try {
          await instance.agents.beginShutdown();
        } catch (error) {
          console.error(`Agent abort failed for bot ${instance.config.botId}`, error);
        }
      }
      for (const instance of instances) {
        await finishDisposal(instance);
      }
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  try {
    for (const instance of instances) {
      await instance.scheduler.start();
      if (shuttingDown) {
        await shutdown("startup interrupted");
        return;
      }
      await instance.tasks.start();
      if (shuttingDown) {
        await shutdown("startup interrupted");
        return;
      }
      await instance.requestBus.start();
      if (shuttingDown) {
        await shutdown("startup interrupted");
        return;
      }
      try {
        await instance.browser.cleanupStaleArtifacts();
      } catch (error) {
        console.error(`Browser artifact cleanup failed for bot ${instance.config.botId}`, error);
      }
      if (shuttingDown) {
        await shutdown("startup interrupted");
        return;
      }
    }
    console.log(`Starting Telegram long polling for ${instances.length} bot(s)`);
    await Promise.all(
      instances.map((instance) =>
        instance.bot.start({
          allowed_updates: ["message", "callback_query", "poll_answer"],
          onStart: (info) => {
            console.log(`Telegram bot @${info.username} (id: ${instance.config.botId}) started`);
            void registerBotCommands(instance.bot).catch((error) =>
              console.error(`Telegram command registration failed for bot ${instance.config.botId}`, error),
            );
          },
        }),
      ),
    );
  } catch (error) {
    await shutdown("startup or polling failure");
    if (shuttingDown && isIntentionalSignalAbort(error)) return;
    throw error;
  }
}
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error("Fatal startup/polling failure", error);
    process.exitCode = 1;
  });
}
