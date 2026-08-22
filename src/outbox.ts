import { readAllowedFile } from "./allowlist.js";
import type { WorkspaceEventLog } from "./events.js";
import { defined, errorMessage } from "./util.js";
import { validateRequest, type WorkspaceOutboxDispatcher, type WorkspaceOutboxDispatchResult, type WorkspaceOutboxRequest } from "./outbox-protocol.js";
import type { SendRequest } from "./request-bus.js";

export type WorkspaceOutboxOptions = {
  /** The workspace directory this outbox operates in. */
  workspace: string;
  /** Sends one validated request to Telegram and returns the response identifiers. */
  dispatch: WorkspaceOutboxDispatcher;
  /** Unified event log for publishing outbox outcomes. */
  events: WorkspaceEventLog;
  logger?: (error: unknown) => void;
};

const MAX_REQUEST_BYTES = 1024 * 1024;

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function extractRequestSummary(request: WorkspaceOutboxRequest): string | undefined {
  switch (request.type) {
    case "send_message":
    case "edit_message":
      return request.text;
    case "send_file":
      return request.caption ?? request.path;
    case "send_poll":
      return request.question;
    case "create_forum_topic":
    case "edit_forum_topic":
      return request.name;
    default:
      return undefined;
  }
}
/**
 * Delivers send_request commands to Telegram: validates the request against the outbox
 * schema, checks its chat_id against the agent's allow list (the egress gate),
 * dispatches, and emits exactly one terminal event to WorkspaceEventLog: outbox_sent or
 * outbox_rejected.
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
    const summary = extractRequestSummary(request);
    const threadId = ("message_thread_id" in request && typeof request.message_thread_id === "number")
      ? request.message_thread_id
      : result?.messageThreadId;

    await this.events.emit({
      type: "outbox_sent",
      requestId: record.requestId,
      chat_id: chatId,
      ...defined({
        message_thread_id: threadId,
        messageId: result?.messageId,
        pollId: result?.pollId,
        request_type: request.type,
        summary: summary ? truncate(summary, 200) : undefined,
        data: result?.data,
      }),
    });
  }

  /** Emits outbox_rejected to WorkspaceEventLog, which logs to events.jsonl and notifies subscribers. */
  private async recordRejection(requestId: string, chatId: number | undefined, error: unknown): Promise<void> {
    await this.events.emit({
      type: "outbox_rejected",
      requestId,
      ...defined({ chat_id: chatId }),
      detail: errorMessage(error),
    });
  }
}
