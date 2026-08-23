import { loadConfig, type BotConfig } from "./config.js";
import { AgentManager, AgentEventRouter } from "./agent.js";
import { WorkspaceOutbox } from "./outbox.js";
import { checkSandboxEnvironment, spawnProcess, terminateActiveSandboxes, terminateProcessGroup } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { AgentCredentials, HostBridge } from "./host-bridge.js";
import { WorkspaceTasks } from "./task.js";
import type { Bot } from "grammy";
import { createTelegramBot, dispatchOutboxRequest, registerBotCommands, TelegramDeliveryQueue } from "./telegram.js";
import { WorkspaceTimeline } from "./events.js";
import { conversationAgent } from "./agent-ref.js";
import { readAllowedFile } from "./allowlist.js";
import { appendJsonl, botPaths } from "./util.js";
import { mkdir } from "node:fs/promises";
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
}

/** Type guard for a record holding a string field; returns the field or "". */
function stringField(record: Record<string, unknown> | undefined, field: string): string {
  const value = record?.[field];
  return typeof value === "string" ? value : "";
}
function integerField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer`);
  return value;
}


export async function ensureTimeline(timelinePath: string): Promise<void> {
  await mkdir(path.dirname(timelinePath), { recursive: true, mode: 0o700 });
  await appendJsonl(timelinePath, []);
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
}

export async function main(): Promise<void> {
  const config = await loadConfig();
  const sandbox = await checkSandboxEnvironment(config.dataDir);
  const { dataDir, bwrapPath } = sandbox;

  const instances: BotInstance[] = await Promise.all(config.bots.map(async (botConfig) => {
    const paths = botPaths(dataDir, botConfig.botId);
    const { workspace } = paths;
    const runtimeConfig = { ...botConfig, dataDir, ...paths };

    await ensureTimeline(paths.timeline);
    await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.attachments, { recursive: true, mode: 0o700 });
    const hostSocketDir = path.resolve(paths.runDir);
    const hostTimeline = path.resolve(paths.timeline);
    const hostAttachments = path.resolve(paths.attachments);
    const credentials = new AgentCredentials();
    const timeline = new WorkspaceTimeline(hostTimeline);
    await timeline.loadOwnership();
    const agentManager = new AgentManager({ workspace }, {
      appRoot: process.cwd(),
      credentials,
      bwrapPath,
      spawnProcess,
      terminateProcessGroup,
      hostSocketDir,
      hostTimeline,
      hostAttachments,
    });
    const deliveryQueue = new TelegramDeliveryQueue();
    const bot = createTelegramBot(runtimeConfig, timeline, deliveryQueue, agentManager);
    const agentRouter = new AgentEventRouter(agentManager, { botInfo: () => bot.botInfo });
    timeline.subscribe((record, rawLine) => agentRouter.onEvent(record, rawLine));

    const outboxInstance = new WorkspaceOutbox({
      workspace,
      timeline,
      dispatch: (chatId, requestId, request) => deliveryQueue.enqueue(chatId, () => dispatchOutboxRequest(bot, paths, chatId, requestId, request)),
    });
    const tasksInstance: WorkspaceTasks = new WorkspaceTasks({
      workspace,
      timeline,
      credentials,
      appRoot: process.cwd(),
      bwrapPath,
      spawnProcess,
      terminateProcessGroup,
      hostSocketDir,
      hostTimeline,
      hostAttachments,
    });
    const schedulerInstance = new WorkspaceScheduler({
      workspace,
      statePath: paths.schedulerState,
      timeline,
    });
    const hostHandlers = {
      send: (params: Record<string, unknown>, actor: Parameters<typeof outboxInstance.send>[1]) => outboxInstance.send(params.request, actor),
      annotate: async (params: Record<string, unknown>) => ({
        occurrences: await timeline.annotateAttachment(stringField(params, "attachment"), stringField(params, "description")),
      }),
      spawn: async (params: Record<string, unknown>, actor: Parameters<typeof outboxInstance.send>[1]) => {
        if (actor.kind !== "conversation") throw new Error("Only conversation agents can spawn tasks");
        return tasksInstance.spawn(stringField(params, "prompt"), actor);
      },
      cancel: async (params: Record<string, unknown>) => ({ status: await tasksInstance.cancel(stringField(params, "runId")) }),
      steerTask: async (params: Record<string, unknown>) => ({ status: await tasksInstance.steer(stringField(params, "runId"), stringField(params, "message")) }),
      steerConversation: async (params: Record<string, unknown>, actor: Parameters<typeof outboxInstance.send>[1]) => {
        if (actor.kind !== "conversation") throw new Error("Only conversation agents can steer conversations");
        const chatId = integerField(params, "chat_id");
        const threadId = params.message_thread_id === undefined ? 0 : integerField(params, "message_thread_id");
        const message = stringField(params, "message").trim();
        if (message.length === 0) throw new Error("message must be a non-empty string");
        const allowed = await readAllowedFile(workspace);
        if (allowed.status !== "ready" || !allowed.chats.includes(chatId)) throw new Error(`Chat ${chatId} is not on the allow list`);
        // Self-targeting is safe: interrupt only queues a steer on the active worker.
        await agentManager.interrupt(`Conversation ${actor.chatId}:${actor.threadId} delegated work to you:\n${message}`, conversationAgent(chatId, threadId));
        return { status: "delivered" };
      },
    };
    const bridge: HostBridge = new HostBridge({
      socketPath: path.join(hostSocketDir, "host.sock"),
      credentials,
      handlers: hostHandlers,
    });
    const taskBridge: HostBridge = new HostBridge({
      socketPath: path.join(hostSocketDir, "host-task.sock"),
      credentials,
      handlers: { annotate: hostHandlers.annotate },
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
      await instance.tasks.start();
      if (shuttingDown) {
        await shutdown("startup interrupted");
        return;
      }
      await instance.scheduler.start();
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