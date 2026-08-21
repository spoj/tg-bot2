import { parseConfig } from "./config.js";
import { AgentManager } from "./agent.js";
import { WorkspaceOutbox } from "./outbox.js";
import { checkSandboxEnvironment, spawnProcess, terminateActiveSandboxes, terminateProcessGroup } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { WorkspaceRequestBus } from "./request-bus.js";
import { WorkspaceTasks } from "./task.js";
import { createTelegramBot, dispatchOutboxRequest, registerBotCommands, TelegramDeliveryQueue } from "./telegram.js";
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
}

export async function main(): Promise<void> {
  const config = parseConfig();
  const sandbox = await checkSandboxEnvironment(config.dataDir);
  const { dataDir, bwrapPath } = sandbox;
  const runtimeConfig = { ...config, dataDir };
  const paths = botPaths(dataDir, runtimeConfig.botId);
  const { workspace } = paths;

  const agentManager = new AgentManager({ workspace }, { appRoot: process.cwd(), bwrapPath, spawnProcess, terminateProcessGroup });
  const deliveryQueue = new TelegramDeliveryQueue();
  const bot = createTelegramBot(runtimeConfig, agentManager, deliveryQueue);
  const schedulerInstance = new WorkspaceScheduler({
    workspace,
    run: (prompt) => agentManager.followup(prompt),
  });
  const outboxInstance = new WorkspaceOutbox({
    dispatch: (chatId, request) => deliveryQueue.enqueue(chatId, () => dispatchOutboxRequest(bot, paths, chatId, request)),
    agent: agentManager,
  });
  const tasksInstance = new WorkspaceTasks({
    workspace,
    appRoot: process.cwd(),
    bwrapPath,
    spawnProcess,
    terminateProcessGroup,
    agent: agentManager,
  });
  const requestBus = new WorkspaceRequestBus({
    workspace,
    onSend: (record, ws, resume) => outboxInstance.handleSendRequest(record, ws, resume),
    onSpawn: (record, ws) => tasksInstance.handleSpawnRequest(record, ws),
    onCancel: (record, ws) => tasksInstance.handleCancelRequest(record, ws),
  });
  tasksInstance.flush = requestBus;

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
      const agentShutdown = agentManager.beginShutdown().catch((error) => {
        console.error("Agent abort failed", error);
      });
      await agentShutdown;
      await finishDisposal({ agents: agentManager, scheduler: schedulerInstance, requestBus, tasks: tasksInstance, delivery: deliveryQueue });
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
    await tasksInstance.start();
    if (shuttingDown) {
      await shutdown("startup interrupted");
      return;
    }
    await requestBus.start();
    if (shuttingDown) {
      await shutdown("startup interrupted");
      return;
    }
    console.log("Starting Telegram long polling");
    await bot.start({
      allowed_updates: ["message", "callback_query", "poll_answer"],
      onStart: (info) => {
        console.log(`Telegram bot @${info.username} started`);
        void registerBotCommands(bot).catch((error) => console.error("Telegram command registration failed", error));
      },
    });
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
