import type { AgentManager } from "./agent.js";
import { readAllowedFile } from "./allowlist.js";
import { appendChatEvent, appendSystemEvent } from "./events.js";
import { defined, errorMessage } from "./util.js";
import { validateRequest, type WorkspaceOutboxDispatcher, type WorkspaceOutboxDispatchResult, type WorkspaceOutboxRequest } from "./outbox-protocol.js";
import type { SendRequest } from "./request-bus.js";

export type WorkspaceOutboxOptions = {
  /** Sends one validated request to Telegram and returns the response identifiers. */
  dispatch: WorkspaceOutboxDispatcher;
  /** Receives a followup per rejected send, naming the requestId and the failure detail. */
  agent: Pick<AgentManager, "followup">;
  logger?: (error: unknown) => void;
};

const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * Delivers send_request commands to Telegram: validates the request against the outbox
 * schema, checks its chat_id against the agent's allow list (the egress gate), claims
 * the command (outbox_claimed), dispatches, and records exactly one terminal event —
 * outbox_sent or outbox_rejected — plus a chat.jsonl send confirmation when Telegram
 * returned a message id. A resumed command (the host crashed between claim and terminal
 * event) dispatches again without claiming twice.
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

  async handleSendRequest(record: SendRequest, workspace: string, resume: boolean): Promise<void> {
    if (record.request === null || typeof record.request !== "object" || Array.isArray(record.request)) {
      await this.recordRejection(workspace, record.requestId, undefined, new Error("Outbox request must be a JSON object"));
      return;
    }
    const raw = JSON.stringify(record.request);
    if (raw.length > MAX_REQUEST_BYTES) {
      await this.recordRejection(workspace, record.requestId, undefined, new Error(`Outbox request exceeds ${MAX_REQUEST_BYTES} bytes`));
      return;
    }
    let request: WorkspaceOutboxRequest;
    try {
      request = validateRequest({ ...record.request, version: 1 });
    } catch (error) {
      await this.recordRejection(workspace, record.requestId, undefined, error);
      return;
    }
    const chatId = request.chat_id;
    const allowed = await readAllowedFile(workspace);
    const chatAllowed = allowed.status === "ready" && allowed.chats.some((entry) => entry.chat_id === chatId);
    if (!chatAllowed) {
      await this.recordRejection(workspace, record.requestId, chatId, new Error(`Chat ${chatId} is not on the allow list`));
      return;
    }
    if (!resume) {
      await appendSystemEvent(workspace, { type: "outbox_claimed", requestId: record.requestId, chat_id: chatId });
    }
    let result: WorkspaceOutboxDispatchResult | undefined;
    try {
      result = await this.dispatch(chatId, request);
    } catch (error) {
      await this.recordRejection(workspace, record.requestId, chatId, error);
      return;
    }
    await appendSystemEvent(workspace, {
      type: "outbox_sent",
      requestId: record.requestId,
      chat_id: chatId,
      ...defined({ messageId: result?.messageId, pollId: result?.pollId, data: result?.data }),
    });
    if (result !== undefined && (result.messageId !== undefined || result.data !== undefined)) {
      try {
        await appendChatEvent(workspace, {
          type: "send",
          chat_id: chatId,
          kind: request.type,
          requestId: record.requestId,
          ...defined({ messageId: result.messageId, pollId: result.pollId, data: result.data }),
        });
      } catch (error) {
        // Delivery succeeded; a lost ack or result must never resend the request.
        this.report(error);
      }
    }
  }

  /** Records the rejection in system.jsonl and sends the agent a followup naming the requestId. */
  private async recordRejection(workspace: string, requestId: string, chatId: number | undefined, error: unknown): Promise<void> {
    const message = `Send ${requestId} rejected: ${errorMessage(error)}`;
    await appendSystemEvent(workspace, { type: "outbox_rejected", requestId, ...defined({ chat_id: chatId }), detail: message });
    void this.agent.followup(message).catch((error) => this.report(error));
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt send processing.
    }
  }
}
