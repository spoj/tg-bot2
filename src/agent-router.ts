import path from "node:path";
import { conversationSessionPath, type ConversationAgentRef } from "./agent-ref.js";
import { USER_INTERRUPT_MAX_WAIT_MS, type AgentNotifier } from "./agent.js";
import type { ConnectorRegistry } from "./connector.js";
import type { TimelineRecord } from "./events.js";
import { readRegularFileBounded } from "./util.js";

const NOTIFICATION_SETTINGS_MAX_BYTES = 1 * 1024 * 1024;

async function loadNotificationSettings(workspace: string, target: ConversationAgentRef): Promise<Record<string, unknown>> {
  const filePath = path.join(workspace, ".pi", "sessions", conversationSessionPath(target), "notifications.json");
  try {
    const value: unknown = JSON.parse((await readRegularFileBounded(filePath, NOTIFICATION_SETTINGS_MAX_BYTES)).toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class AgentEventRouter {
  constructor(
    private readonly agents: AgentNotifier,
    private readonly options: { workspace: string; connectors: ConnectorRegistry },
  ) {
    this.agents.registerTimelineRecovery?.((record, rawLine) => this.onEvent(record, rawLine));
  }

  async onEvent(record: TimelineRecord, rawLine: string): Promise<void> {
    const identity = { id: record.id, sequence: record.seq };
    if (record.type === "schedule_fired") {
      if (!record.conversation) throw new Error("schedule_fired has no conversation owner");
      await this.agents.followup(`Scheduled instruction due ${String(record.dueAt)}:\n${String(record.prompt)}`, record.conversation, identity);
      await this.markProcessed(record);
      return;
    }
    const target = record.conversation;
    if (!target || !record.connectorId) {
      await this.markProcessed(record);
      return;
    }
    const connector = this.options.connectors.get(record.connectorId);
    const settings = await loadNotificationSettings(this.options.workspace, target);
    const attention = connector.attention?.(record, settings);
    if (!attention) {
      await this.markProcessed(record);
      return;
    }
    const prompt = connector.notificationText(record, rawLine);
    if (attention === "followup") {
      await this.agents.followup(prompt, target, identity);
    } else {
      await this.agents.interrupt(prompt, target, USER_INTERRUPT_MAX_WAIT_MS, identity);
    }
    await this.markProcessed(record);
  }

  private async markProcessed(record: TimelineRecord): Promise<void> {
    await this.agents.markTimelineProcessed?.(record.seq);
  }
}
