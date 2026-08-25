import type { ConversationAgentRef } from "./agent-ref.js";
import type { TimelineAttachment, TimelineRecord } from "./events.js";

export type ConnectorSendResult = {
  request: Record<string, unknown>;
  response?: unknown;
  attachments?: TimelineAttachment[] | undefined;
  summary?: Record<string, unknown> | undefined;
  cleanup?: (() => Promise<void>) | undefined;
};

export interface WorkspaceConnector {
  readonly id: string;
  readonly prompt: string;
  send(request: unknown, actor: ConversationAgentRef): Promise<ConnectorSendResult>;
  parseConversation(value: unknown): ConversationAgentRef;
  authorizeConversation(target: ConversationAgentRef): Promise<void>;
  notificationText(record: TimelineRecord, rawLine: string): string;
  attention?(record: TimelineRecord, settings: Record<string, unknown>): "interrupt" | "followup" | undefined;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, WorkspaceConnector>();

  register(connector: WorkspaceConnector): void {
    if (this.connectors.has(connector.id)) throw new Error(`Duplicate connector ${connector.id}`);
    this.connectors.set(connector.id, connector);
  }

  get(connectorId: string): WorkspaceConnector {
    const connector = this.connectors.get(connectorId);
    if (!connector) throw new Error(`Unknown connector ${connectorId}`);
    return connector;
  }

  prompt(connectorId: string): string {
    return this.get(connectorId).prompt;
  }

  parseConversation(value: unknown): ConversationAgentRef {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("conversation must be an object");
    const connectorId = (value as Record<string, unknown>).connectorId;
    if (typeof connectorId !== "string") throw new Error("conversation.connectorId must be a string");
    return this.get(connectorId).parseConversation(value);
  }

  authorizeConversation(target: ConversationAgentRef): Promise<void> {
    return this.get(target.connectorId).authorizeConversation(target);
  }
}
