export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleRow = {
  prompt: string;
  start: string;
  recurrence: Recurrence | null;
  origin: { chat_id: number; message_thread_id?: number | undefined };
};

export const SCHEDULES_PROMPT = `Edit /workspace/.schedules.json to manage schedules: {version:1,schedules:[{prompt,start,recurrence,origin:{chat_id,message_thread_id}}]}.
- prompt: complete task instructions. The task cannot contact Telegram directly.
- start: first run as a UTC ISO-8601 timestamp ending in Z.
- recurrence: hourly, daily, weekly, or null for one run.
- origin: required owning conversation and settlement destination. chat_id identifies the chat; message_thread_id defaults to 0.
When due, the host records schedule_fired and launches an anonymous task. Its settlement wakes the origin conversation, which reads the task output and handles any user communication.
`;
