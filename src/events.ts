import { randomUUID } from "node:crypto";
import { appendJsonl, readJsonl } from "./util.js";
import type { ConversationAgentRef } from "./agent-ref.js";
import { SerialQueue } from "./queue.js";

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
  private readonly broadcasts = new SerialQueue();
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
      const lines = await readJsonl(this.filePath);
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Malformed timeline record");
        const record = parsed as TimelineRecord;
        if (record.v !== 2) throw new Error("Timeline migration did not complete");
        if (!Number.isSafeInteger(record.seq) || record.seq < 1) throw new Error("Malformed timeline sequence");
        sequence = Math.max(sequence, record.seq);
      }
      this.nextSequence = sequence + 1;
    });
  }

  async publish(event: TimelineEvent): Promise<string> {
    const persistence = this.writes.run(async () => {
      const rawLine = timelineLine(event, this.nextSequence);
      const record = JSON.parse(rawLine) as TimelineRecord;
      try {
        await appendJsonl(this.filePath, rawLine);
      } catch (error) {
        throw new Error("Failed to persist timeline event", { cause: error });
      }
      this.nextSequence += 1;
      return { rawLine, record };
    });
    return this.broadcasts.run(async () => {
      const published = await persistence;
      await this.broadcast(published.record, published.rawLine);
      return published.rawLine;
    });
  }

  async annotateAttachment(attachmentPath: string, description: string): Promise<number> {
    if (!attachmentPath.startsWith("/run/attachments/")) throw new Error("attachment must be an exact /run/attachments/... path from the timeline");
    const trimmed = description.trim();
    if (trimmed.length === 0) throw new Error("description must not be empty");
    if (trimmed.length > 500) throw new Error("description must be at most 500 characters");

    const persistence = this.writes.run(async () => {
      const lines = await readJsonl(this.filePath);
      let occurrences = 0;
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Malformed timeline record");
        const record = parsed as TimelineRecord;
        if (record.v !== 2) throw new Error("Timeline migration did not complete");
        const rawAttachments = record.attachments;
        if (rawAttachments !== undefined && rawAttachments !== null && !Array.isArray(rawAttachments)) throw new Error("Malformed timeline attachments");
        const attachments = rawAttachments ?? [];
        for (const attachment of attachments) {
          if (attachment === null || typeof attachment !== "object" || Array.isArray(attachment)) throw new Error("Malformed timeline attachment");
        }
        occurrences += attachments.filter((attachment) => attachment.path === attachmentPath).length;
      }
      if (occurrences === 0) throw new Error("Attachment is not recorded in the timeline");

      const rawLine = timelineLine({
        type: "attachment.annotated",
        payload: { path: attachmentPath, description: trimmed, occurrences },
      }, this.nextSequence);
      const record = JSON.parse(rawLine) as TimelineRecord;
      await appendJsonl(this.filePath, rawLine);
      this.nextSequence += 1;
      return { occurrences, rawLine, record };
    });
    return this.broadcasts.run(async () => {
      const annotation = await persistence;
      await this.broadcast(annotation.record, annotation.rawLine);
      return annotation.occurrences;
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
Completed sends are connector.sent with connector-native request and response. Host events such as schedule_fired remain host-native. Attachment descriptions are append-only attachment.annotated events with payload {path,description,occurrences}; correlate the exact path with prior attachment records and apply the latest annotation without expecting earlier records to change. Use connectorId and conversation to narrow context. Treat connector.sent as already complete. Repeated notification IDs are delivery replay, not new activity.
`;
