import { randomUUID } from "node:crypto";
import type { AgentRef } from "./agent-ref.js";
import { conversationAgent } from "./agent-ref.js";
import { readAllowedFile } from "./allowlist.js";
import type { WorkspaceTimeline } from "./events.js";
import { defined, errorMessage } from "./util.js";
import { validateRequest, type WorkspaceOutboxDispatchResult, type WorkspaceOutboxDispatcher, type WorkspaceOutboxRequest } from "./outbox-protocol.js";

export type WorkspaceOutboxOptions = {
  workspace: string;
  dispatch: WorkspaceOutboxDispatcher;
  timeline: WorkspaceTimeline;
  pollOwners?: Map<string, number>;
};

export type OutboxSendResult = {
  requestId: string;
  method: string;
  messageId?: number;
  pollId?: string;
  message_thread_id?: number;
};

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_OUTBOX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 60;

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

export function applyDefaultTarget(request: Record<string, unknown>, actor: AgentRef): Record<string, unknown> {
  if (request.chat_id !== undefined) return request;
  if (actor.kind !== "conversation") {
    throw new Error("chat_id is required when calling send from a background task");
  }
  return {
    ...request,
    chat_id: actor.chatId,
    ...(request.message_thread_id === undefined && actor.threadId > 0 ? { message_thread_id: actor.threadId } : {}),
  };
}

export class WorkspaceOutbox {
  private readonly workspace: string;
  private readonly dispatch: WorkspaceOutboxDispatcher;
  private readonly timeline: WorkspaceTimeline;
  private readonly pollOwners: Map<string, number> | undefined;

  constructor(options: WorkspaceOutboxOptions) {
    this.workspace = options.workspace;
    this.dispatch = options.dispatch;
    this.timeline = options.timeline;
    this.pollOwners = options.pollOwners;
  }

  async send(request: unknown, actor: AgentRef): Promise<OutboxSendResult> {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Outbox request must be a JSON object");
    }
    const raw = JSON.stringify(request);
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error(`Outbox request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    const validated = this.parseValidated(applyDefaultTarget(request as Record<string, unknown>, actor));
    const chatId = validated.chat_id;
    const allowed = await readAllowedFile(this.workspace);
    if (allowed.status !== "ready" || !allowed.chats.includes(chatId)) {
      throw new Error(`Chat ${chatId} is not on the allow list`);
    }

    const requestId = randomUUID();
    let result: WorkspaceOutboxDispatchResult | undefined;
    try {
      result = await this.dispatchWithRetry(chatId, requestId, validated);
    } catch (error) {
      throw new Error(errorMessage(error));
    }

    const recorded = result?.request ?? validated;
    const threadId = result?.messageThreadId ?? recorded.message_thread_id;
    const target = conversationAgent(chatId, threadId ?? 0);
    if (result?.pollId) this.pollOwners?.set(result.pollId, chatId);
    await this.timeline.publish({
      type: "sent",
      requestId,
      actor,
      target,
      request: recorded,
      ...defined({ messageId: result?.messageId, pollId: result?.pollId }),
    });
    return {
      requestId,
      method: recorded.method,
      ...defined({
        messageId: result?.messageId,
        pollId: result?.pollId,
        message_thread_id: threadId,
      }),
    };
  }

  private parseValidated(request: Record<string, unknown>): WorkspaceOutboxRequest {
    return validateRequest(request);
  }

  private async dispatchWithRetry(chatId: number, requestId: string, validated: WorkspaceOutboxRequest): Promise<WorkspaceOutboxDispatchResult | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dispatch(chatId, requestId, validated);
      } catch (error) {
        const retryAfter = retryDelaySeconds(error);
        if (retryAfter === undefined || attempt >= MAX_OUTBOX_ATTEMPTS) throw error;
        await sleep(retryAfter * 1000);
      }
    }
  }
}
