import { loadConfig, type BotConfig } from "./config.js";
import { AgentManager, AgentEventRouter } from "./agent.js";
import { WorkspaceOutbox } from "./outbox.js";
import { checkSandboxEnvironment, spawnProcess, terminateActiveSandboxes, terminateProcessGroup } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { HostBridge } from "./host-bridge.js";
import { WorkspaceTasks } from "./task.js";
import type { Bot } from "grammy";
import { HostBrowserManager } from "./browser.js";
import { createTelegramBot, dispatchOutboxRequest, registerBotCommands, TelegramDeliveryQueue } from "./telegram.js";
import { EVENTS_FILE, WorkspaceEventLog } from "./events.js";
import { TG_BOT_DIR, botPaths, isMissing } from "./util.js";
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
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
  bridge: Pick<HostBridge, "stop">;
  taskBridge: Pick<HostBridge, "stop">;
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
  bridge: HostBridge;
  taskBridge: HostBridge;
  tasks: WorkspaceTasks;
  delivery: TelegramDeliveryQueue;
  browser: HostBrowserManager;
}

/** Type guard for a record holding a string field; returns the field or "". */
function stringField(record: Record<string, unknown> | undefined, field: string): string {
  const value = record?.[field];
  return typeof value === "string" ? value : "";
}

/**
 * One-time migration from the legacy agent-writable log location to the
 * host-owned one (`DATA_DIR/bots/<id>/events.jsonl`). Only regular files are
 * moved; a planted symlink is ignored. Ensures the host log exists afterwards
 * so the read-only bind mount into worker sandboxes always has a source.
 */
export async function migrateEventsLog(workspace: string, eventsLog: string): Promise<void> {
  try {
    await lstat(eventsLog);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const legacy = path.join(workspace, TG_BOT_DIR, EVENTS_FILE);
  let moved = false;
  try {
    const entry = await lstat(legacy);
    if (entry.isFile() && !entry.isSymbolicLink()) {
      await mkdir(path.dirname(eventsLog), { recursive: true, mode: 0o700 });
      await rename(legacy, eventsLog);
      moved = true;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (!moved) {
    await mkdir(path.dirname(eventsLog), { recursive: true, mode: 0o700 });
    await writeFile(eventsLog, "", { encoding: "utf8", mode: 0o600, flag: "ax" }).catch((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }
}

// Stops the scheduler, bridge, and tasks, disposes agents, terminates
// sandboxes, and drains the delivery queue. Each step is guarded so a failure
// in one never skips the rest.
export async function finishDisposal(services: DisposableServices): Promise<void> {
  try {
    await services.scheduler.stop();
  } catch (error) {
    console.error("Scheduler shutdown failed", error);
  }
  try {
    await services.bridge.stop();
  } catch (error) {
    console.error("Host bridge shutdown failed", error);
  }
  try {
    await services.taskBridge.stop();
  } catch (error) {
    console.error("Host task bridge shutdown failed", error);
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

  const instances: BotInstance[] = await Promise.all(config.bots.map(async (botConfig) => {
    const paths = botPaths(dataDir, botConfig.botId);
    const { workspace } = paths;
    const runtimeConfig = { ...botConfig, dataDir, ...paths };

    await migrateEventsLog(workspace, paths.eventsLog);
    await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
    const hostSocketDir = path.resolve(paths.runDir);
    const hostEventsLog = path.resolve(paths.eventsLog);

    const eventLog = new WorkspaceEventLog(hostEventsLog);
    const agentManager = new AgentManager({ workspace }, {
      appRoot: process.cwd(),
      bwrapPath,
      spawnProcess,
      terminateProcessGroup,
      events: eventLog,
      hostSocketDir,
      hostEventsLog,
    });
    const deliveryQueue = new TelegramDeliveryQueue();
    const bot = createTelegramBot(runtimeConfig, eventLog, deliveryQueue, agentManager);
    const agentRouter = new AgentEventRouter(agentManager, { botInfo: () => bot.botInfo });
    eventLog.subscribe((record, rawLine) => agentRouter.onEvent(record, rawLine));

    const outboxInstance = new WorkspaceOutbox({
      workspace,
      events: eventLog,
      dispatch: (chatId, request) => deliveryQueue.enqueue(chatId, () => dispatchOutboxRequest(bot, paths, chatId, request)),
    });
    const browserManager = new HostBrowserManager({ workspace, events: eventLog });
    const tasksInstance: WorkspaceTasks = new WorkspaceTasks({
      workspace,
      events: eventLog,
      appRoot: process.cwd(),
      bwrapPath,
      spawnProcess,
      terminateProcessGroup,
      hostSocketDir,
      hostEventsLog,
    });
    // The scheduler fires due runs by launching tasks directly; the fired event is
    // written first, and boot reconciliation relaunches occurrences lost in between.
    const schedulerInstance = new WorkspaceScheduler({
      workspace,
      events: eventLog,
      fireTask: async (runId, prompt) => {
        await tasksInstance.spawn(prompt, undefined, runId);
      },
    });
    const hostHandlers = {
      send: (params: Record<string, unknown>) => outboxInstance.send(params.request, stringField(params, "origin") || undefined),
      spawn: (params: Record<string, unknown>) => tasksInstance.spawn(stringField(params, "prompt"), stringField(params, "origin") || undefined),
      cancel: async (params: Record<string, unknown>) => ({ status: await tasksInstance.cancel(stringField(params, "runId")) }),
      steerTask: async (params: Record<string, unknown>) => ({ status: await tasksInstance.steer(stringField(params, "runId"), stringField(params, "message")) }),
      startBrowser: async (params: Record<string, unknown>) => ({ ...(await browserManager.startBrowser(stringField(params, "origin") || undefined)) }),
    };
    const bridge: HostBridge = new HostBridge({
      socketPath: path.join(hostSocketDir, "host.sock"),
      handlers: hostHandlers,
    });
    // Task sandboxes get a capability-restricted socket: send and start_browser only.
    const taskBridge: HostBridge = new HostBridge({
      socketPath: path.join(hostSocketDir, "host-task.sock"),
      handlers: { send: hostHandlers.send, startBrowser: hostHandlers.startBrowser },
    });
    return {
      config: runtimeConfig,
      paths,
      bot,
      agents: agentManager,
      scheduler: schedulerInstance,
      bridge,
      taskBridge,
      tasks: tasksInstance,
      delivery: deliveryQueue,
      browser: browserManager,
    };
  }));



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
      await instance.bridge.start();
      if (shuttingDown) {
        await shutdown("startup interrupted");
        return;
      }
      await instance.taskBridge.start();
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
          allowed_updates: [
            "message",
            "edited_message",
            "callback_query",
            "poll_answer",
            "message_reaction",
            "my_chat_member",
            "chat_join_request",
          ],
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