export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleRow = {
  prompt: string;
  start: string;
  recurrence: Recurrence | null;
  owner: { chat_id: number; message_thread_id?: number | undefined };
};

export const SCHEDULES_PROMPT = `Edit /workspace/.schedules.json to manage schedules: {version:1,schedules:[{prompt,start,recurrence,owner:{chat_id,message_thread_id}}]}.
- prompt: complete instructions for the owning conversation agent.
- start: first run as a UTC ISO-8601 timestamp ending in Z.
- recurrence: hourly, daily, weekly, or null for one run.
- owner: required conversation to wake. chat_id identifies the chat; message_thread_id defaults to 0.
When due, the host records schedule_fired and wakes the owner with the prompt. The owner acts directly or delegates with spawn or steer_conversation.
`;
