import { randomUUID } from "node:crypto";
import { readAllowedFile } from "./allowlist.js";
import type { WorkspaceEventLog } from "./events.js";
import { defined, errorMessage } from "./util.js";
import { validateRequest, type WorkspaceOutboxDispatchResult, type WorkspaceOutboxDispatcher, type WorkspaceOutboxRequest } from "./outbox-protocol.js";

export type WorkspaceOutboxOptions = {
  /** The workspace directory this outbox operates in. */
  workspace: string;
  /** Sends one validated request to Telegram and returns the response identifiers. */
  dispatch: WorkspaceOutboxDispatcher;
  /** Unified event log for publishing outbox outcomes. */
  events: WorkspaceEventLog;
  logger?: (error: unknown) => void;
};

/** Synchronous outcome of one send tool call, returned directly to the agent. */
export type OutboxSendResult = {
  requestId: string;
  messageId?: number;
  pollId?: string;
  message_thread_id?: number;
  request_type: string;
  summary?: string;
};

function extractRequestSummary(request: WorkspaceOutboxRequest): string | undefined {
  switch (request.type) {
    case "send_message": return request.text;
    case "send_file": return request.caption;
    case "edit_message": return request.text;
    case "send_poll": return request.question;
    case "send_location": return request.venue?.title;
    case "create_forum_topic":
    case "edit_forum_topic": return request.name;
    default: return undefined;
  }
}

function extractRawThreadId(request: unknown): number | undefined {
  if (request !== null && typeof request === "object" && !Array.isArray(request)) {
    const threadId = (request as Record<string, unknown>).message_thread_id;
    if (typeof threadId === "number" && Number.isSafeInteger(threadId)) {
      return threadId;
    }
  }
  return undefined;
}

const MAX_REQUEST_BYTES = 1024 * 1024;

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
/**
 * Delivers send tool calls to Telegram synchronously: validates the request
 * against the outbox schema, checks its chat_id against the agent's allow list
 * (the egress gate), dispatches, records exactly one terminal event
 * (outbox_sent or outbox_rejected) in the events log, and returns the outcome
 * to the caller. Failures throw with the rejection detail.
 */
export class WorkspaceOutbox {
  private readonly workspace: string;
  private readonly dispatch: WorkspaceOutboxDispatcher;
  private readonly events: WorkspaceEventLog;
  private readonly logger: (error: unknown) => void;

  constructor(options: WorkspaceOutboxOptions) {
    this.workspace = options.workspace;
    this.dispatch = options.dispatch;
    this.events = options.events;
    this.logger = options.logger ?? ((error) => console.error("Workspace outbox error", error));
  }

  async send(request: unknown, origin?: string | undefined): Promise<OutboxSendResult> {
    const requestId = randomUUID();
    const rawThreadId = extractRawThreadId(request);
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      await this.reject(requestId, undefined, undefined, new Error("Outbox request must be a JSON object"), origin);
    }
    const raw = JSON.stringify(request);
    if (raw.length > MAX_REQUEST_BYTES) {
      await this.reject(requestId, undefined, rawThreadId, new Error(`Outbox request exceeds ${MAX_REQUEST_BYTES} bytes`), origin);
    }
    const validated = await this.parseValidated(request as Record<string, unknown>, requestId, origin);
    const chatId = validated.chat_id;
    const threadId = ("message_thread_id" in validated && typeof validated.message_thread_id === "number")
      ? validated.message_thread_id
      : rawThreadId;
    const allowed = await readAllowedFile(this.workspace);
    if (allowed.status !== "ready" || !allowed.chats.includes(chatId)) {
      await this.reject(requestId, chatId, threadId, new Error(`Chat ${chatId} is not on the allow list`), origin);
    }
    let result: WorkspaceOutboxDispatchResult | undefined;
    try {
      result = await this.dispatch(chatId, validated);
    } catch (error) {
      await this.reject(requestId, chatId, threadId, error, origin);
    }
    const summary = extractRequestSummary(validated);
    const resolvedThreadId = ("message_thread_id" in validated && typeof validated.message_thread_id === "number")
      ? validated.message_thread_id
      : result?.messageThreadId;
    await this.events.emit({
      type: "outbox_sent",
      requestId,
      chat_id: chatId,
      ...defined({
        origin,
        message_thread_id: resolvedThreadId,
        messageId: result?.messageId,
        pollId: result?.pollId,
        request_type: validated.type,
        summary: summary ? truncate(summary, 200) : undefined,
        data: result?.data,
      }),
    });
    return {
      requestId,
      request_type: validated.type,
      ...defined({
        messageId: result?.messageId,
        pollId: result?.pollId,
        message_thread_id: resolvedThreadId,
        summary: summary ? truncate(summary, 200) : undefined,
      }),
    };
  }
  /** Validates the outbox schema; records outbox_rejected and throws on failure. */
  private async parseValidated(request: Record<string, unknown>, requestId: string, origin: string | undefined): Promise<WorkspaceOutboxRequest> {
    try {
      return validateRequest({ ...request, version: 1 });
    } catch (error) {
      await this.reject(requestId, undefined, extractRawThreadId(request), error, origin);
      throw error; // unreachable; reject throws
    }
  }


  /** Records outbox_rejected in the events log and throws the rejection detail. */
  private async reject(
    requestId: string,
    chatId: number | undefined,
    threadId: number | undefined,
    error: unknown,
    origin?: string | undefined,
  ): Promise<never> {
    await this.recordRejection(requestId, chatId, threadId, error, origin);
    throw new Error(errorMessage(error));
  }

  /** Emits outbox_rejected to the events log. */
  private async recordRejection(requestId: string, chatId: number | undefined, threadId: number | undefined, error: unknown, origin?: string | undefined): Promise<void> {
    try {
      await this.events.emit({
        type: "outbox_rejected",
        requestId,
        detail: errorMessage(error),
        ...defined({ origin, chat_id: chatId, message_thread_id: threadId }),
      });
    } catch (emitError) {
      this.logger(emitError);
    }
  }
}
