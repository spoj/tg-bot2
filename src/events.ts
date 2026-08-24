import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { conversationAgent, type AgentRef, type ConversationAgentRef } from "./agent-ref.js";
import { appendJsonl } from "./util.js";
import { SerialQueue } from "./queue.js";

export type TimelineAttachment = {
  type?: string | undefined;
  path?: string | undefined;
  mimeType?: string | undefined;
  originalName?: string | undefined;
  failure?: string | undefined;
  description?: string | undefined;
};


export type TimelineEvent =
  | {
      type: "message";
      chat_id: number;
      message: unknown;
      attachments: TimelineAttachment[];
    }
  | {
      type: "edited_message";
      chat_id: number;
      message: unknown;
      attachments: TimelineAttachment[];
    }
  | {
      type: "callback";
      chat_id: number;
      callback_query: unknown;
    }
  | {
      type: "poll_answer";
      chat_id: number;
      poll_answer: unknown;
    }
  | {
      type: "message_reaction";
      chat_id: number;
      message_reaction: unknown;
    }
  | {
      type: "my_chat_member";
      chat_id: number;
      my_chat_member: unknown;
    }
  | {
      type: "chat_join_request";
      chat_id: number;
      chat_join_request: unknown;
    }
  | {
      type: "sent";
      requestId: string;
      actor: AgentRef;
      target: ConversationAgentRef;
      request: Record<string, unknown>;
      attachments?: TimelineAttachment[] | undefined;
      messageId?: number | undefined;
      pollId?: string | undefined;
    }
  | {
      type: "task_started";
      runId: string;
      owner: ConversationAgentRef;
      prompt: string;
      model?: string | undefined;
      thinking?: string | undefined;
    }
  | {
      type: "task_continued";
      runId: string;
      owner: ConversationAgentRef;
      prompt: string;
      model?: string | undefined;
      thinking?: string | undefined;
    }
  | {
      type: "task_finished";
      runId: string;
      owner: ConversationAgentRef;
      prompt: string;
      status: "done" | "failed" | "aborted";
      exitCode: number | null;
      stderr?: string | undefined;
    }
  | {
      type: "schedule_fired";
      scheduleId: string;
      occurrenceId: string;
      prompt: string;
      dueAt: string;
      owner: ConversationAgentRef;
    }
  | {
      type: "schedule_taken";
      scheduleId: string;
      previousOwner: ConversationAgentRef;
      owner: ConversationAgentRef;
    };

export type RuntimeEvent = TimelineEvent | {
  type: "task_progress";
  owner: ConversationAgentRef;
  tasks: Array<{
    runId: string;
    prompt: string;
    runningMs: number;
    idleMs: number | null;
    lastOutput?: string | undefined;
  }>;
};

export type BotEvent = RuntimeEvent;

export type TimelineEnvelope = {
  v: 1;
  id: string;
  seq?: number | undefined;
  t: string;
};

export type TimelineRecord<T = TimelineEvent> = TimelineEnvelope & T;
export const TIMELINE_FILE = "timeline.jsonl";

export type EventListener = (record: TimelineEnvelope & RuntimeEvent, rawLine: string) => void | Promise<void>;

export class WorkspaceTimeline {
  private readonly listeners = new Set<EventListener>();
  private readonly writes = new SerialQueue();
  private readonly messageOwners = new Map<string, ConversationAgentRef>();
  private readonly pollOwners = new Map<string, ConversationAgentRef>();
  private nextSequence = 1;

  constructor(
    readonly filePath: string,
    private readonly logger: (error: unknown) => void = (error) => console.error("Workspace timeline error", error),
  ) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async loadOwnership(): Promise<void> {
    await this.writes.run(async () => {
      this.messageOwners.clear();
      this.pollOwners.clear();
      let sequence = 0;
      const lines = (await readFile(this.filePath, "utf8")).split("\n");
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line) as TimelineRecord;
        sequence = Math.max(sequence, typeof record.seq === "number" ? record.seq : sequence + 1);
        this.recordOwnership(record);
      }
      this.nextSequence = sequence + 1;
    });
  }

  messageOwner(chatId: number, messageId: number): ConversationAgentRef | undefined {
    return this.messageOwners.get(`${chatId}:${messageId}`);
  }

  pollOwner(pollId: string): ConversationAgentRef | undefined {
    return this.pollOwners.get(pollId);
  }


  async publish(event: TimelineEvent): Promise<string> {
    return this.writes.run(async () => {
      const rawLine = timelineLine(event, this.nextSequence);
      const record = JSON.parse(rawLine) as TimelineRecord;
      if (!(await appendTimelineRecords(this.filePath, [record]))) {
        throw new Error("Failed to persist timeline event");
      }
      this.nextSequence += 1;
      this.recordOwnership(record);
      this.broadcast(record, rawLine);
      return rawLine;
    });
  }

  async annotateAttachment(attachmentPath: string, description: string): Promise<number> {
    if (!attachmentPath.startsWith("/run/attachments/")) {
      throw new Error("attachment must be an exact /run/attachments/... path from the timeline");
    }
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
        if (record.type !== "message" && record.type !== "edited_message" && record.type !== "sent") continue;
        const matching = record.attachments?.filter((attachment) => attachment.path === attachmentPath);
        if (!matching?.length) continue;
        record.attachments = record.attachments?.map((attachment) => attachment.path === attachmentPath
          ? { ...attachment, description: trimmed }
          : attachment);
        occurrences += matching.length;
        lines[index] = JSON.stringify(record);
      }
      if (occurrences === 0) throw new Error("Attachment is not recorded in the timeline");
      await writeFile(this.filePath, lines.join("\n"), "utf8");
      return occurrences;
    });
  }

  notify(event: Exclude<RuntimeEvent, TimelineEvent>): void {
    const rawLine = timelineLine(event);
    this.broadcast(JSON.parse(rawLine) as TimelineEnvelope & RuntimeEvent, rawLine);
  }

  private recordOwnership(record: TimelineRecord): void {
    if (record.type === "message" || record.type === "edited_message") {
      const message = record.message as { message_id?: unknown; message_thread_id?: unknown; poll?: { id?: unknown } };
      const threadId = typeof message.message_thread_id === "number" ? message.message_thread_id : 0;
      const owner = conversationAgent(record.chat_id, threadId);
      if (typeof message.message_id === "number" && Number.isSafeInteger(message.message_id)) {
        this.messageOwners.set(`${record.chat_id}:${message.message_id}`, owner);
      }
      if (typeof message.poll?.id === "string") this.pollOwners.set(message.poll.id, owner);
      return;
    }
    if (record.type !== "sent") return;
    if (record.messageId !== undefined) this.messageOwners.set(`${record.target.chatId}:${record.messageId}`, record.target);
    if (record.pollId !== undefined) this.pollOwners.set(record.pollId, record.target);
  }

  private broadcast(record: TimelineEnvelope & RuntimeEvent, rawLine: string): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(record, rawLine);
        if (result && typeof result.catch === "function") result.catch((error) => this.logger(error));
      } catch (error) {
        this.logger(error);
      }
    }
  }
}

export async function appendTimelineEvents(filePath: string, events: RuntimeEvent[]): Promise<boolean> {
  return appendTimelineRecords(filePath, events.map((event) => JSON.parse(timelineLine(event)) as TimelineEnvelope & RuntimeEvent));
}

async function appendTimelineRecords(filePath: string, records: Array<TimelineEnvelope & RuntimeEvent>): Promise<boolean> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await appendJsonl(filePath, records.map((record) => JSON.stringify(record)));
    return true;
  } catch (error) {
    console.error("Failed to append timeline.jsonl", error);
    return false;
  }
}

export function timelineLine(event: object, sequence?: number): string {
  return JSON.stringify({ v: 1, id: randomUUID(), ...(sequence === undefined ? {} : { seq: sequence }), t: new Date().toISOString(), ...event });
}

export const TIMELINE_PROMPT = `/run/timeline.jsonl is read-only shared context across all chats. Each JSON line has {v:1,id,seq,t,type,...}; id is stable and seq is monotonic for persisted events.
- Inbound: message, edited_message, callback, poll_answer, message_reaction, my_chat_member, chat_join_request. Attachment objects may include a searchable description added later by annotate.
- Completed actions: sent {actor,target,request,...}, task_started, task_continued, task_finished, schedule_fired, schedule_taken. Sent events include host-managed attachment paths when applicable.
Use chat_id and message_thread_id to narrow context before searching globally. Treat sent actions as already complete. Repeated notification IDs are delivery replay, not new user input.
`;
