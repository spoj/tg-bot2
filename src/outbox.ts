import { randomUUID } from "node:crypto";
import type { AgentManager } from "./agent.js";
import { appendChatEvent, appendSystemEvent } from "./events.js";
import { defined, errorMessage } from "./util.js";
import { validateRequest, type WorkspaceOutboxDispatcher, type WorkspaceOutboxDispatchResult, type WorkspaceOutboxRequest } from "./outbox-protocol.js";
import type { SessionToolCall } from "./session-bus.js";

export type WorkspaceOutboxOptions = {
  /** Sends one validated request to Telegram and returns the response identifiers. */
  dispatch: WorkspaceOutboxDispatcher;
  /** Receives a followup per rejected send, quoting the request and the failure detail. */
  agent: Pick<AgentManager, "followup">;
  logger?: (error: unknown) => void;
};

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_QUOTE_LENGTH = 160;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Delivers send tool calls to Telegram: validates the call's arguments against the
 * outbox request schema, claims the call (outbox_claimed), dispatches, and records
 * exactly one terminal event — outbox_sent or outbox_rejected — plus a chat.jsonl
 * send confirmation when Telegram returned a message id. A resumed claim (the host
 * crashed between claim and terminal event) dispatches without claiming again.
 */
export class WorkspaceOutbox {
  private readonly agent: WorkspaceOutboxOptions["agent"];
  private readonly dispatch: WorkspaceOutboxDispatcher;
  private readonly logger: (error: unknown) => void;

  constructor(options: WorkspaceOutboxOptions) {
    this.agent = options.agent;
    this.dispatch = options.dispatch;
    this.logger = options.logger ?? ((error) => console.error("Workspace outbox error", error));
  }

  async handleSend(
    call: SessionToolCall,
    chatId: number,
    workspace: string,
    resume: { requestId: string } | undefined,
  ): Promise<void> {
    const raw = JSON.stringify(call.args);
    if (raw.length > MAX_REQUEST_BYTES) {
      await this.recordRejection(chatId, workspace, resume?.requestId ?? randomUUID(), call, new Error(`Outbox request exceeds ${MAX_REQUEST_BYTES} bytes`), { raw });
      return;
    }
    let request: WorkspaceOutboxRequest;
    try {
      request = validateRequest({ ...call.args, version: 1 });
    } catch (error) {
      await this.recordRejection(chatId, workspace, resume?.requestId ?? randomUUID(), call, error, { raw });
      return;
    }
    const requestId = resume?.requestId ?? randomUUID();
    if (resume === undefined) {
      await appendSystemEvent(workspace, { type: "outbox_claimed", requestId, callRef: call.ref, request });
    }
    let result: WorkspaceOutboxDispatchResult | undefined;
    try {
      result = await this.dispatch(chatId, request);
    } catch (error) {
      await this.recordRejection(chatId, workspace, requestId, call, error, { request });
      return;
    }
    await appendSystemEvent(workspace, {
      type: "outbox_sent",
      requestId,
      callRef: call.ref,
      request,
      ...defined({ messageId: result?.messageId, pollId: result?.pollId, data: result?.data }),
    });
    if (result !== undefined && (result.messageId !== undefined || result.data !== undefined)) {
      try {
        await appendChatEvent(workspace, {
          type: "send",
          kind: request.type,
          requestId,
          ...defined({ messageId: result.messageId, pollId: result.pollId, data: result.data }),
        });
      } catch (error) {
        // Delivery succeeded; a lost ack or result must never resend the request.
        this.report(error);
      }
    }
  }

  /** Records the rejection in system.jsonl and sends the agent a followup quoting the request. */
  private async recordRejection(
    chatId: number,
    workspace: string,
    requestId: string,
    call: SessionToolCall,
    error: unknown,
    context: { request?: WorkspaceOutboxRequest; raw?: string },
  ): Promise<void> {
    const message = `Send rejected: ${errorMessage(error)}. Request: ${truncate(context.raw ?? JSON.stringify(context.request), MAX_QUOTE_LENGTH)}`;
    await appendSystemEvent(workspace, {
      type: "outbox_rejected",
      requestId,
      callRef: call.ref,
      detail: message,
      ...defined({ request: context.request }),
      ...defined({ raw: context.raw }),
    });
    void this.agent.followup(chatId, message).catch((error) => this.report(error));
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt send processing.
    }
  }
}
