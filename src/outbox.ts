import { randomUUID } from "node:crypto";
import { sameConversation, type AgentRef, type ConversationAgentRef } from "./agent-ref.js";
import { readAllowedFile } from "./allowlist.js";
import type { WorkspaceTimeline } from "./events.js";
import { defined, errorMessage } from "./util.js";
import { validateRequest, type WorkspaceOutboxDispatchResult, type WorkspaceOutboxDispatcher, type WorkspaceOutboxRequest } from "./outbox-protocol.js";

export type WorkspaceOutboxOptions = {
  workspace: string;
  dispatch: WorkspaceOutboxDispatcher;
  timeline: WorkspaceTimeline;
};

export type OutboxSendResult = {
  requestId: string;
  method: string;
  messageId?: number;
  pollId?: string;
  attachments?: string[];
  message_thread_id?: number;
};

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_OUTBOX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 60;
const MESSAGE_MUTATIONS = new Set([
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "deleteMessage",
  "setMessageReaction",
  "stopPoll",
]);

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

export function applyOwnerTarget(request: Record<string, unknown>, actor: ConversationAgentRef): Record<string, unknown> {
  if (request.chat_id !== undefined && request.chat_id !== actor.chatId) {
    throw new Error("send cannot target another conversation's chat");
  }
  if (request.message_thread_id !== undefined && request.message_thread_id !== actor.threadId) {
    throw new Error("send cannot target another conversation's thread");
  }
  return {
    ...request,
    chat_id: actor.chatId,
    ...(actor.threadId > 0 ? { message_thread_id: actor.threadId } : {}),
  };
}

export class WorkspaceOutbox {
  private readonly workspace: string;
  private readonly dispatch: WorkspaceOutboxDispatcher;
  private readonly timeline: WorkspaceTimeline;

  constructor(options: WorkspaceOutboxOptions) {
    this.workspace = options.workspace;
    this.dispatch = options.dispatch;
    this.timeline = options.timeline;
  }

  async send(request: unknown, actor: AgentRef): Promise<OutboxSendResult> {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Outbox request must be a JSON object");
    }
    if (actor.kind !== "conversation") throw new Error("Background tasks cannot call send");
    const raw = JSON.stringify(request);
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error(`Outbox request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    const validated = this.parseValidated(applyOwnerTarget(request as Record<string, unknown>, actor));
    const chatId = validated.chat_id;
    const allowed = await readAllowedFile(this.workspace);
    if (allowed.status !== "ready" || !allowed.chats.includes(chatId)) {
      throw new Error(`Chat ${chatId} is not on the allow list`);
    }
    this.assertMutationOwner(validated, actor);

    const requestId = randomUUID();
    let result: WorkspaceOutboxDispatchResult;
    try {
      result = await this.dispatchWithRetry(chatId, requestId, validated);
    } catch (error) {
      throw new Error(errorMessage(error));
    }

    const recorded = result.request ?? validated;
    const threadId = result.messageThreadId ?? recorded.message_thread_id;
    const target = actor;
    const attachmentPaths = result.attachmentPaths ?? [];
    await this.timeline.publish({
      type: "sent",
      requestId,
      actor,
      target,
      request: recorded,
      attachments: attachmentPaths.map((path) => ({ path })),
      ...defined({ messageId: result.messageId, pollId: result.pollId }),
    });
    return {
      requestId,
      method: recorded.method,
      ...defined({
        messageId: result.messageId,
        pollId: result.pollId,
        message_thread_id: threadId,
        attachments: attachmentPaths,
      }),
    };
  }

  private assertMutationOwner(request: WorkspaceOutboxRequest, actor: ConversationAgentRef): void {
    if (!MESSAGE_MUTATIONS.has(request.method)) return;
    if (typeof request.message_id !== "number" || !Number.isSafeInteger(request.message_id)) {
      throw new Error(`${request.method} requires an owned message_id`);
    }
    const owner = this.timeline.messageOwner(actor.chatId, request.message_id);
    if (!owner || !sameConversation(owner, actor)) {
      throw new Error(`Message ${request.message_id} is not owned by this conversation`);
    }
  }

  private parseValidated(request: Record<string, unknown>): WorkspaceOutboxRequest {
    return validateRequest(request);
  }

  private async dispatchWithRetry(chatId: number, requestId: string, validated: WorkspaceOutboxRequest): Promise<WorkspaceOutboxDispatchResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dispatch(chatId, requestId, validated) ?? {};
      } catch (error) {
        const retryAfter = retryDelaySeconds(error);
        if (retryAfter === undefined || attempt >= MAX_OUTBOX_ATTEMPTS) throw error;
        await sleep(retryAfter * 1000);
      }
    }
  }
}
