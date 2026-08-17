import { parseConfig, chatPaths } from "./config.js";
import { AgentManager } from "./agent.js";
import { WorkspaceOutbox } from "./outbox.js";
import { checkSandboxEnvironment, terminateActiveSandboxes } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { createTelegramBot, closeTelegramIngress, deleteTelegramMessage, flushTelegramIngress, recordPollOwner, sendTelegramEditMessage, sendTelegramLocation, sendTelegramPoll, sendTelegramReaction, sendTelegramRichMessage, sendWorkspaceFile, stopTelegramPoll, TelegramDeliveryQueue } from "./telegram.js";
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
  outbox: Pick<WorkspaceOutbox, "stop">;
  delivery: Pick<TelegramDeliveryQueue, "drain">;
}

// Stops the scheduler and outbox, disposes agents, terminates sandboxes, and
// drains the delivery queue. Each step is guarded so a failure in one never
// skips the rest. Called by the graceful shutdown() path after it overlaps
// beginShutdown with the ingress drain.
export async function finishDisposal(services: DisposableServices): Promise<void> {
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

  const agentManager = new AgentManager(runtimeConfig, { appRoot: process.cwd(), bwrapPath });
  const deliveryQueue = new TelegramDeliveryQueue();
  const bot = createTelegramBot(runtimeConfig, agentManager, deliveryQueue);
  const schedulerInstance = new WorkspaceScheduler({
    dataDir,
    run: (chatId, prompt) => agentManager.prompt(chatId, prompt, "follow-up"),
  });
  const outboxInstance = new WorkspaceOutbox({
    dataDir,
    dispatch: async (chatId, request) => {
      return deliveryQueue.enqueue(chatId, async () => {
        switch (request.type) {
          case "send_file":
            return {
              messageId: await sendWorkspaceFile(bot, {
                chatId,
                workspace: chatPaths(dataDir, chatId).workspace,
                sandboxPath: request.path,
                ...(request.caption === undefined ? {} : { caption: request.caption }),
                ...(request.kind === undefined ? {} : { kind: request.kind }),
                ...(request.reply_to_message_id === undefined ? {} : { replyToMessageId: request.reply_to_message_id }),
                ...(request.disable_notification === undefined ? {} : { disableNotification: request.disable_notification }),
              }),
            };
          case "send_message":
            return {
              messageId: await sendTelegramRichMessage(bot, chatId, {
                text: request.text,
                ...(request.parse_mode === undefined ? {} : { parseMode: request.parse_mode }),
                ...(request.reply_markup === undefined ? {} : { replyMarkup: request.reply_markup }),
                ...(request.reply_to_message_id === undefined ? {} : { replyToMessageId: request.reply_to_message_id }),
                ...(request.entities === undefined ? {} : { entities: request.entities }),
                ...(request.link_preview_options === undefined ? {} : { linkPreviewOptions: request.link_preview_options }),
                ...(request.disable_notification === undefined ? {} : { disableNotification: request.disable_notification }),
              }),
            };
          case "send_location":
            return {
              messageId: await sendTelegramLocation(bot, chatId, {
                latitude: request.latitude,
                longitude: request.longitude,
                ...(request.horizontal_accuracy === undefined ? {} : { horizontalAccuracy: request.horizontal_accuracy }),
                ...(request.heading === undefined ? {} : { heading: request.heading }),
                ...(request.live_period === undefined ? {} : { livePeriod: request.live_period }),
                ...(request.venue === undefined ? {} : { venue: request.venue }),
                ...(request.reply_to_message_id === undefined ? {} : { replyToMessageId: request.reply_to_message_id }),
                ...(request.disable_notification === undefined ? {} : { disableNotification: request.disable_notification }),
              }),
            };
          case "send_poll": {
            const sent = await sendTelegramPoll(bot, chatId, {
              question: request.question,
              options: request.options,
              ...(request.is_anonymous === undefined ? {} : { isAnonymous: request.is_anonymous }),
              ...(request.allows_multiple_answers === undefined ? {} : { allowsMultipleAnswers: request.allows_multiple_answers }),
              ...(request.poll_type === undefined ? {} : { pollType: request.poll_type }),
              ...(request.correct_option_id === undefined ? {} : { correctOptionId: request.correct_option_id }),
              ...(request.reply_to_message_id === undefined ? {} : { replyToMessageId: request.reply_to_message_id }),
              ...(request.disable_notification === undefined ? {} : { disableNotification: request.disable_notification }),
            });
            try {
              await recordPollOwner(dataDir, chatId, sent.pollId, sent.messageId);
            } catch (error) {
              console.error("Failed to record poll ownership", error);
            }
            return sent;
          }
          case "stop_poll":
            return {
              data: await stopTelegramPoll(bot, chatId, request.message_id, request.reply_markup),
            };
          case "send_reaction":
            await sendTelegramReaction(bot, chatId, request.message_id, request.reaction);
            return {};
          case "edit_message":
            return {
              messageId: await sendTelegramEditMessage(bot, {
                chatId,
                messageId: request.message_id,
                ...(request.text === undefined ? {} : { text: request.text }),
                ...(request.parse_mode === undefined ? {} : { parseMode: request.parse_mode }),
                ...(request.entities === undefined ? {} : { entities: request.entities }),
                ...(request.link_preview_options === undefined ? {} : { linkPreviewOptions: request.link_preview_options }),
                ...(request.reply_markup === undefined ? {} : { replyMarkup: request.reply_markup }),
              }),
            };
          case "delete_message":
            await deleteTelegramMessage(bot, chatId, request.message_id);
            return {};
          default: {
            const unhandled: never = request;
            void unhandled;
            throw new Error("Unhandled outbox request type");
          }
        }
      });
    },
  });

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
      allowed_updates: ["message", "callback_query", "poll_answer"],
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
  main().catch((error) => {
    console.error("Fatal startup/polling failure", error);
    process.exitCode = 1;
  });
}
