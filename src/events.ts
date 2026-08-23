import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentRef, ConversationAgentRef, TaskTrigger } from "./agent-ref.js";
import { appendJsonl } from "./util.js";

export type TimelineEvent =
  | {
      type: "message";
      chat_id: number;
      message: unknown;
      attachments: Array<{ type: string; path?: string | undefined; mimeType?: string | undefined; originalName?: string | undefined; failure?: string | undefined }>;
    }
  | {
      type: "edited_message";
      chat_id: number;
      message: unknown;
      attachments: Array<{ type: string; path?: string | undefined; mimeType?: string | undefined; originalName?: string | undefined; failure?: string | undefined }>;
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
      messageId?: number | undefined;
      pollId?: string | undefined;
    }
  | {
      type: "task_finished";
      runId: string;
      trigger: TaskTrigger;
      prompt: string;
      status: "done" | "failed" | "aborted";
      exitCode: number | null;
      stderr?: string | undefined;
    }
  | {
      type: "schedule_fired";
      occurrenceId: string;
      prompt: string;
      dueAt: string;
    };

export type RuntimeEvent = TimelineEvent | {
  type: "task_progress";
  trigger: TaskTrigger;
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
  t: string;
};

export type TimelineRecord<T = TimelineEvent> = TimelineEnvelope & T;
export const TIMELINE_FILE = "timeline.jsonl";

export type EventListener = (record: TimelineEnvelope & RuntimeEvent, rawLine: string) => void | Promise<void>;

export class WorkspaceTimeline {
  private readonly listeners = new Set<EventListener>();

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

  async publish(event: TimelineEvent): Promise<string> {
    const rawLine = timelineLine(event);
    const record = JSON.parse(rawLine) as TimelineRecord;
    this.broadcast(record, rawLine);
    await appendTimelineEvents(this.filePath, [record]);
    return rawLine;
  }

  notify(event: Exclude<RuntimeEvent, TimelineEvent>): void {
    const rawLine = timelineLine(event);
    this.broadcast(JSON.parse(rawLine) as TimelineEnvelope & RuntimeEvent, rawLine);
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
  try {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await appendJsonl(filePath, events.map(timelineLine));
    return true;
  } catch (error) {
    console.error("Failed to append timeline.jsonl", error);
    return false;
  }
}

export function timelineLine(event: object): string {
  return JSON.stringify({ v: 1, t: new Date().toISOString(), ...event });
}

export const TIMELINE_PROMPT = `/run/timeline.jsonl is read-only shared context across all chats. Each JSON line has {v:1,t,type,...}.
- Inbound: message, edited_message, callback, poll_answer, message_reaction, my_chat_member, chat_join_request.
- Completed actions: sent {actor,target,request,...}, task_finished, schedule_fired.
Use chat_id and message_thread_id to narrow context before searching globally. Treat sent actions as already complete. The host does not read this file for commands, recovery, or state.
`;
