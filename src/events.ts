import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ConversationAgentRef } from "./agent-ref.js";
import { SerialQueue } from "./queue.js";
import { appendJsonl } from "./util.js";

export type TimelineAttachment = {
  type?: string | undefined;
  path?: string | undefined;
  mimeType?: string | undefined;
  originalName?: string | undefined;
  failure?: string | undefined;
  description?: string | undefined;
};

export type TimelineEvent = {
  type: string;
  connectorId?: string | undefined;
  conversation?: ConversationAgentRef | undefined;
  actor?: ConversationAgentRef | undefined;
  payload?: unknown;
  request?: Record<string, unknown> | undefined;
  response?: unknown;
  attachments?: TimelineAttachment[] | undefined;
  [key: string]: unknown;
};

export type TimelineEnvelope = {
  v: 2;
  id: string;
  seq: number;
  t: string;
};

export type TimelineRecord = TimelineEnvelope & TimelineEvent;
export type BotEvent = TimelineEvent;
export type EventListener = (record: TimelineRecord, rawLine: string) => void | Promise<void>;
export const TIMELINE_FILE = "timeline.jsonl";


export class WorkspaceTimeline {
  private readonly listeners = new Set<EventListener>();
  private readonly writes = new SerialQueue();
  private nextSequence = 1;

  constructor(
    readonly filePath: string,
    private readonly logger: (error: unknown) => void = (error) => console.error("Workspace timeline error", error),
  ) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.writes.run(async () => {
      let sequence = 0;
      const lines = (await readFile(this.filePath, "utf8")).split("\n");
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line) as TimelineRecord;
        if (record.v !== 2) throw new Error("Timeline migration did not complete");
        sequence = Math.max(sequence, record.seq);
      }
      this.nextSequence = sequence + 1;
    });
  }

  async publish(event: TimelineEvent): Promise<string> {
    return this.writes.run(async () => {
      const rawLine = timelineLine(event, this.nextSequence);
      const record = JSON.parse(rawLine) as TimelineRecord;
      try {
        await appendJsonl(this.filePath, rawLine);
      } catch (error) {
        throw new Error("Failed to persist timeline event", { cause: error });
      }
      this.nextSequence += 1;
      await this.broadcast(record, rawLine);
      return rawLine;
    });
  }

  async annotateAttachment(attachmentPath: string, description: string): Promise<number> {
    if (!attachmentPath.startsWith("/run/attachments/")) throw new Error("attachment must be an exact /run/attachments/... path from the timeline");
    const trimmed = description.trim();
    if (trimmed.length === 0) throw new Error("description must not be empty");
    if (trimmed.length > 500) throw new Error("description must be at most 500 characters");

    return this.writes.run(async () => {
      const lines = (await readFile(this.filePath, "utf8")).split("\n");
      let occurrences = 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line) continue;
        const record = JSON.parse(line) as TimelineRecord;
        const matching = record.attachments?.filter((attachment) => attachment.path === attachmentPath);
        if (!matching?.length) continue;
        record.attachments = record.attachments?.map((attachment) => attachment.path === attachmentPath ? { ...attachment, description: trimmed } : attachment);
        occurrences += matching.length;
        lines[index] = JSON.stringify(record);
      }
      if (occurrences === 0) throw new Error("Attachment is not recorded in the timeline");
      await writeFile(this.filePath, lines.join("\n"), "utf8");
      return occurrences;
    });
  }

  private async broadcast(record: TimelineRecord, rawLine: string): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => {
      try {
        await listener(record, rawLine);
      } catch (error) {
        this.logger(error);
      }
    }));
  }
}

export function timelineLine(event: TimelineEvent, sequence: number): string {
  return JSON.stringify({ v: 2, id: randomUUID(), seq: sequence, t: new Date().toISOString(), ...event });
}

export const TIMELINE_PROMPT = `/run/timeline.jsonl is read-only shared memory for this workspace. Each JSON line has {v:2,id,seq,t,type,...}; id is stable and seq is monotonic.
Connector events retain native structure: {connectorId,conversation:{connectorId,conversationKey,address},type,payload,attachments}. Telegram types are telegram.message, telegram.edited_message, telegram.callback, telegram.poll_answer, telegram.message_reaction, telegram.my_chat_member, and telegram.chat_join_request.
Completed sends are connector.sent with connector-native request and response. Host events such as schedule_fired remain host-native. Use connectorId and conversation to narrow context. Treat connector.sent as already complete. Repeated notification IDs are delivery replay, not new activity.
`;
