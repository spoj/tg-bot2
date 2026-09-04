import type { ConversationAgentRef } from "./agent-ref.js";

export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleInput = {
  prompt: string;
  start: string;
  recurrence: Recurrence | null;
};

export type Schedule = ScheduleInput & {
  id: string;
  owner: ConversationAgentRef;
  next_due_at: string | null;
};

