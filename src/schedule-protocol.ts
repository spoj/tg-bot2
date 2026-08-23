export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleRow = {
  prompt: string;
  start: string;
  recurrence: Recurrence | null;
};

export const SCHEDULES_PROMPT = `Edit /workspace/.schedules.json to manage schedules: {version:1,schedules:[{prompt,start,recurrence}]}.
- prompt: complete task instructions, including the destination chat_id.
- start: first run as a UTC ISO-8601 timestamp ending in Z.
- recurrence: hourly, daily, weekly, or null for one run.
When due, the host records schedule_fired and launches the task. Scheduled tasks deliver through send and do not return a settlement to a parent conversation.
`;
