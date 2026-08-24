export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleInput = {
  prompt: string;
  start: string;
  recurrence: Recurrence | null;
};

export type ScheduleOwner = {
  chat_id: number;
  message_thread_id?: number | undefined;
};

export type Schedule = ScheduleInput & {
  id: string;
  owner: ScheduleOwner;
  next_due_at: string | null;
};

export const SCHEDULES_PROMPT = `Schedules are host-managed. Inspect the read-only current state in /run/schedules.json.
- schedule_add creates a schedule owned by this conversation and returns its host-generated ID.
- schedule_replace fully replaces an owned schedule's prompt, start, and recurrence. Changing start resets its next due time; other changes preserve the pending occurrence.
- schedule_remove deletes an owned schedule.
- schedule_take makes this conversation the owner of any existing schedule without changing its timing.
- prompt: complete instructions for the owning conversation agent.
- start: first run as a UTC ISO-8601 timestamp ending in Z.
- recurrence: hourly, daily, weekly, or null for one run.
When due, the host records schedule_fired and wakes the current owner. The owner acts directly or delegates with spawn or steer_conversation.
`;
