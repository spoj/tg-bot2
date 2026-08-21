import { readAllowedFile } from "./allowlist.js";
import type { EventSink } from "./events.js";
import { defined, errorMessage } from "./util.js";
import { validateRequest, type WorkspaceOutboxDispatcher, type WorkspaceOutboxDispatchResult, type WorkspaceOutboxRequest } from "./outbox-protocol.js";
import type { SendRequest } from "./request-bus.js";

export type WorkspaceOutboxOptions = {
  /** The workspace directory this outbox operates in. */
  workspace: string;
  /** Sends one validated request to Telegram and returns the response identifiers. */
  dispatch: WorkspaceOutboxDispatcher;
  /** Unified event sink for outbox outcomes. */
  events: EventSink;
  logger?: (error: unknown) => void;
};

const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * Delivers send_request commands to Telegram: validates the request against the outbox
 * schema, checks its chat_id against the agent's allow list (the egress gate),
 * dispatches, and emits exactly one terminal event to EventSink: outbox_sent or
 * outbox_rejected.
 */
export class WorkspaceOutbox {
  private readonly workspace: string;
  private readonly dispatch: WorkspaceOutboxDispatcher;
  private readonly events: EventSink;
  private readonly logger: (error: unknown) => void;

  constructor(options: WorkspaceOutboxOptions) {
    this.workspace = options.workspace;
    this.dispatch = options.dispatch;
    this.events = options.events;
    this.logger = options.logger ?? ((error) => console.error("Workspace outbox error", error));
  }

  async handleSendRequest(record: SendRequest, _workspace = this.workspace): Promise<void> {
    if (record.request === null || typeof record.request !== "object" || Array.isArray(record.request)) {
      await this.recordRejection(record.requestId, undefined, new Error("Outbox request must be a JSON object"));
      return;
    }
    const raw = JSON.stringify(record.request);
    if (raw.length > MAX_REQUEST_BYTES) {
      await this.recordRejection(record.requestId, undefined, new Error(`Outbox request exceeds ${MAX_REQUEST_BYTES} bytes`));
      return;
    }
    let request: WorkspaceOutboxRequest;
    try {
      request = validateRequest({ ...record.request, version: 1 });
    } catch (error) {
      await this.recordRejection(record.requestId, undefined, error);
      return;
    }
    const chatId = request.chat_id;
    const allowed = await readAllowedFile(this.workspace);
    if (allowed.status !== "ready" || !allowed.chats.includes(chatId)) {
      await this.recordRejection(record.requestId, chatId, new Error(`Chat ${chatId} is not on the allow list`));
      return;
    }
    let result: WorkspaceOutboxDispatchResult | undefined;
    try {
      result = await this.dispatch(chatId, request);
    } catch (error) {
      await this.recordRejection(record.requestId, chatId, error);
      return;
    }
    await this.events.emit({
      type: "outbox_sent",
      requestId: record.requestId,
      chat_id: chatId,
      ...defined({ messageId: result?.messageId, pollId: result?.pollId, data: result?.data }),
    });
  }

  /** Emits outbox_rejected to EventSink, which logs to events.jsonl and notifies the agent. */
  private async recordRejection(requestId: string, chatId: number | undefined, error: unknown): Promise<void> {
    await this.events.emit({
      type: "outbox_rejected",
      requestId,
      ...defined({ chat_id: chatId }),
      detail: errorMessage(error),
    });
  }
}
