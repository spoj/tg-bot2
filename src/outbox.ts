import { randomUUID } from "node:crypto";
import type { AgentRef } from "./agent-ref.js";
import type { ConnectorRegistry } from "./connector.js";
import type { WorkspaceTimeline } from "./events.js";

export type WorkspaceOutboxOptions = {
  connectors: ConnectorRegistry;
  timeline: WorkspaceTimeline;
};

export type OutboxSendResult = {
  requestId: string;
  [key: string]: unknown;
};

const MAX_REQUEST_BYTES = 1024 * 1024;

export class WorkspaceOutbox {
  private readonly connectors: ConnectorRegistry;
  private readonly timeline: WorkspaceTimeline;

  constructor(options: WorkspaceOutboxOptions) {
    this.connectors = options.connectors;
    this.timeline = options.timeline;
  }

  async send(request: unknown, actor: AgentRef): Promise<OutboxSendResult> {
    if (request === null || typeof request !== "object" || Array.isArray(request)) throw new Error("Connector request must be a JSON object");
    const raw = JSON.stringify(request);
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) throw new Error(`Connector request exceeds ${MAX_REQUEST_BYTES} bytes`);
    const connector = this.connectors.get(actor.connectorId);
    const requestId = randomUUID();
    const result = await connector.send(request, actor);
    await this.timeline.publish({
      type: "connector.sent",
      connectorId: connector.id,
      actor,
      conversation: actor,
      request: result.request,
      ...(result.response === undefined ? {} : { response: result.response }),
      ...(result.attachments === undefined ? {} : { attachments: result.attachments }),
    });
    return { requestId, ...(result.summary ?? {}) };
  }
}
