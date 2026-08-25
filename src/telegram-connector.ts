import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import { sameConversation, type ConversationAgentRef } from "./agent-ref.js";
import { readAllowedFile } from "./allowlist.js";
import type { WorkspaceConnector, ConnectorSendResult } from "./connector.js";
import type { Config } from "./config.js";
import type { TimelineRecord, WorkspaceTimeline } from "./events.js";
import { validateRequest, type WorkspaceOutboxRequest } from "./outbox-protocol.js";
import { OUTBOX_PROMPT } from "./outbox-protocol.js";
import type { WorkspaceResources } from "./resource-state.js";
import { telegramAddress, telegramConversation } from "./telegram-ref.js";
import { createTelegramBot, dispatchOutboxRequest, registerBotCommands, TelegramDeliveryQueue, type TelegramDispatchResult } from "./telegram.js";
import { errorMessage } from "./util.js";

const MAX_OUTBOX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 60;
const THREAD_TARGET_METHODS = new Set([
  "sendMessage", "sendPhoto", "sendAudio", "sendVideo", "sendAnimation", "sendVoice", "sendVideoNote", "sendDocument",
  "sendMediaGroup", "sendLocation", "sendVenue", "sendContact", "sendDice", "sendPoll",
  "editForumTopic", "closeForumTopic", "reopenForumTopic", "deleteForumTopic",
]);
const MESSAGE_MUTATIONS = new Set(["editMessageText", "editMessageCaption", "editMessageReplyMarkup", "deleteMessage", "setMessageReaction", "stopPoll"]);

function retryDelaySeconds(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const parameters = "parameters" in error ? error.parameters : undefined;
  if (parameters === null || typeof parameters !== "object") return undefined;
  const retryAfter = "retry_after" in parameters ? parameters.retry_after : undefined;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return undefined;
  return Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function applyOwnerTarget(request: Record<string, unknown>, actor: ConversationAgentRef): Record<string, unknown> {
  const address = telegramAddress(actor);
  if (request.chat_id !== undefined && request.chat_id !== address.chat_id) throw new Error("send cannot target another conversation's chat");
  const { message_thread_id: requestedThreadId, ...withoutThread } = request;
  if (requestedThreadId !== undefined && requestedThreadId !== address.message_thread_id) throw new Error("send cannot target another conversation's thread");
  if (THREAD_TARGET_METHODS.has(String(request.method))) {
    return {
      ...withoutThread,
      chat_id: address.chat_id,
      ...((address.message_thread_id ?? 0) > 0 ? { message_thread_id: address.message_thread_id } : {}),
    };
  }
  return { ...withoutThread, chat_id: address.chat_id };
}

function connectorSendResult(result: TelegramDispatchResult, recorded: WorkspaceOutboxRequest, persistenceError?: string): ConnectorSendResult {
  const attachmentPaths = result.attachmentPaths ?? [];
  const response = result.data ?? {
    ...(typeof result.messageId === "number" ? { message_id: result.messageId } : {}),
    ...(typeof result.pollId === "string" ? { poll_id: result.pollId } : {}),
    ...(typeof result.messageThreadId === "number" ? { message_thread_id: result.messageThreadId } : {}),
  };
  return {
    request: recorded,
    response,
    attachments: attachmentPaths.map((path) => ({ path })),
    summary: {
      method: recorded.method,
      ...(typeof result.messageId === "number" ? { messageId: result.messageId } : {}),
      ...(result.messageIds === undefined ? {} : { messageIds: result.messageIds }),
      ...(typeof result.pollId === "string" ? { pollId: result.pollId } : {}),
      ...(attachmentPaths.length > 0 ? { attachments: attachmentPaths } : {}),
      ...(persistenceError === undefined ? {} : {
        uncertain: true,
        deliveryStatus: "delivered_persistence_failed",
        persistenceError,
      }),
    },
  };
}

export class TelegramConnector implements WorkspaceConnector {
  readonly id: string;
  readonly prompt = `${OUTBOX_PROMPT}When changing both a forum topic title and icon, include name and icon_custom_emoji_id in one editForumTopic request; never split them across calls.\n`;
  readonly bot: Bot;
  readonly delivery = new TelegramDeliveryQueue();
  private agent: { restartAll(): Promise<void> } | undefined;
  private running = false;
  private runPromise: Promise<void> | undefined;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    readonly config: Config,
    private readonly timeline: WorkspaceTimeline,
    private readonly resources: WorkspaceResources,
  ) {
    this.id = config.id;
    this.bot = createTelegramBot(config, timeline, resources, this.delivery, {
      restartAll: async () => {
        if (!this.agent) throw new Error("Agent manager is not ready");
        await this.agent.restartAll();
      },
    });
  }

  setAgent(agent: { restartAll(): Promise<void> }): void {
    this.agent = agent;
  }
  async run(): Promise<void> {
    if (this.stopped) return;
    if (this.runPromise) return this.runPromise;
    const running = this.runInternal();
    this.runPromise = running;
    try {
      await running;
    } finally {
      if (this.runPromise === running) this.runPromise = undefined;
    }
  }

  private async runInternal(): Promise<void> {
    await registerBotCommands(this.bot);
    if (this.stopped) return;
    this.running = true;
    try {
      if (this.stopped) return;
      await this.bot.start({
        allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query", "poll_answer", "message_reaction", "my_chat_member", "chat_join_request"],
        onStart: (info) => console.log(`Telegram connector ${this.id} @${info.username} started`),
      });
    } catch (error) {
      if (!this.stopped) throw error;
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.stopInternal();
    this.stopPromise = stopping;
    return stopping;
  }

  private async stopInternal(): Promise<void> {
    this.stopped = true;
    let failure: unknown;
    if (this.running) {
      try {
        await this.bot.stop();
      } catch (error) {
        failure = error;
      }
    }
    try {
      await this.runPromise?.catch((error) => {
        failure ??= error;
      });
    } catch {
      // The rejection is captured above so delivery draining still runs.
    }
    await this.delivery.drain();
    if (failure !== undefined) throw failure;
  }

  parseConversation(value: unknown): ConversationAgentRef {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("conversation must be an object");
    const raw = value as Record<string, unknown>;
    if (raw.connectorId !== this.id) throw new Error(`Conversation does not belong to ${this.id}`);
    if (raw.address === null || typeof raw.address !== "object" || Array.isArray(raw.address)) throw new Error("conversation.address must be an object");
    const address = raw.address as Record<string, unknown>;
    if (typeof address.chat_id !== "number" || !Number.isSafeInteger(address.chat_id)) throw new Error("conversation.address.chat_id must be a safe integer");
    const threadId = address.message_thread_id ?? 0;
    if (typeof threadId !== "number" || !Number.isSafeInteger(threadId)) throw new Error("conversation.address.message_thread_id must be a safe integer");
    return telegramConversation(this.id, address.chat_id, threadId);
  }

  async authorizeConversation(target: ConversationAgentRef): Promise<void> {
    const address = telegramAddress(target, this.id);
    const allowed = await readAllowedFile(this.config.workspace);
    if (allowed.status !== "ready" || !allowed.chats.includes(address.chat_id)) throw new Error(`Chat ${address.chat_id} is not on the allow list`);
  }

  notificationText(record: TimelineRecord, rawLine: string): string {
    if (record.type === "telegram.my_chat_member" && (record.meta as { group_add?: unknown } | undefined)?.group_add === true) {
      const chatId = record.conversation?.address.chat_id;
      return `Bot was added to group or channel ${String(chatId)}. This chat is already allowed.`;
    }
    return rawLine;
  }
  attention(record: TimelineRecord, settings: Record<string, unknown>): "interrupt" | undefined {
    const mute = Array.isArray(settings.mute) ? settings.mute : [];
    if (mute.includes(record.type)) return undefined;
    const wake = Array.isArray(settings.wake) ? settings.wake : [];
    if (wake.includes(record.type)) return "interrupt";
    if (record.type === "telegram.callback") return "interrupt";
    if (record.type === "telegram.my_chat_member" && (record.meta as { group_add?: unknown } | undefined)?.group_add === true) return "interrupt";
    if (record.type !== "telegram.message") return undefined;
    const meta = record.meta as { private?: unknown; directed?: unknown; channel?: unknown; user_content?: unknown } | undefined;
    return meta?.user_content === true && (meta.private === true || meta.directed === true || meta.channel === true) ? "interrupt" : undefined;
  }

  async send(request: unknown, actor: ConversationAgentRef): Promise<ConnectorSendResult> {
    if (actor.connectorId !== this.id) throw new Error(`Conversation belongs to ${actor.connectorId}, not ${this.id}`);
    if (request === null || typeof request !== "object" || Array.isArray(request)) throw new Error("Telegram request must be a JSON object");
    const validated = validateRequest(applyOwnerTarget(request as Record<string, unknown>, actor));
    const address = telegramAddress(actor, this.id);
    const allowed = await readAllowedFile(this.config.workspace);
    if (allowed.status !== "ready" || !allowed.chats.includes(address.chat_id)) throw new Error(`Chat ${address.chat_id} is not on the allow list`);
    this.assertMutationOwner(validated, actor);

    const requestId = randomUUID();
    let result: TelegramDispatchResult;
    try {
      result = await this.dispatchWithRetry(address.chat_id, requestId, validated);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
    const recorded = result.request ?? validated;
    let persistenceError: string | undefined;
    try {
      await this.persistSendResources(result, recorded, actor, address.chat_id);
    } catch (error) {
      persistenceError = `Failed to persist Telegram delivery ownership: ${errorMessage(error)}`;
    }
    return connectorSendResult(result, recorded, persistenceError);
  }

  private async persistSendResources(
    result: TelegramDispatchResult,
    recorded: WorkspaceOutboxRequest,
    actor: ConversationAgentRef,
    chatId: number,
  ): Promise<void> {
    const messageIds = [
      ...(typeof result.messageId === "number" ? [result.messageId] : []),
      ...(result.messageIds ?? []).filter((messageId) => Number.isSafeInteger(messageId)),
    ];
    await this.resources.setMany([
      ...messageIds.map((messageId) => ({ connectorId: this.id, kind: "message" as const, key: `${chatId}:${messageId}`, owner: actor })),
      ...(typeof result.pollId === "string"
        ? [{ connectorId: this.id, kind: "poll" as const, key: result.pollId, owner: actor }]
        : []),
    ]);
    if (recorded.method === "deleteMessage" && typeof recorded.message_id === "number") {
      await this.resources.delete(this.id, "message", `${chatId}:${recorded.message_id}`);
    }
  }

  private assertMutationOwner(request: WorkspaceOutboxRequest, actor: ConversationAgentRef): void {
    if (!MESSAGE_MUTATIONS.has(request.method)) return;
    const address = telegramAddress(actor, this.id);
    if (request.method === "stopPoll") {
      if (typeof request.message_id !== "number" || !Number.isSafeInteger(request.message_id)) throw new Error("stopPoll requires an owned message_id");
    } else if (typeof request.message_id !== "number" || !Number.isSafeInteger(request.message_id)) {
      throw new Error(`${request.method} requires an owned message_id`);
    }
    const owner = this.resources.owner(this.id, "message", `${address.chat_id}:${request.message_id}`);
    if (!owner || !sameConversation(owner, actor)) throw new Error(`Message ${request.message_id} is not owned by this conversation`);
  }
  private async dispatchWithRetry(chatId: number, requestId: string, request: WorkspaceOutboxRequest): Promise<TelegramDispatchResult> {
    return this.delivery.enqueue(chatId, async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const allowed = await readAllowedFile(this.config.workspace);
          if (allowed.status !== "ready" || !allowed.chats.includes(chatId)) throw new Error(`Chat ${chatId} is not on the allow list`);
          return await dispatchOutboxRequest(this.bot, this.config, chatId, requestId, request);
        } catch (error) {
          const retryAfter = retryDelaySeconds(error);
          if (retryAfter === undefined || attempt >= MAX_OUTBOX_ATTEMPTS) throw error;
          await sleep(retryAfter * 1000);
        }
      }
    });
  }
}
