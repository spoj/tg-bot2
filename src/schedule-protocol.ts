export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleRecord = {
  id: string;
  prompt: string;
  dueAt: string;
  recurrence: Recurrence | null;
  enabled: boolean;
  lastRunAt: string | null;
  runCount: number;
};

export const SCHEDULES_PROMPT = `Schedules are stored in /workspace/.tg-bot/schedules.json. Its root object is
{version:1,schedules:[...]}. Each schedule record requires id, prompt, dueAt,
recurrence, enabled, lastRunAt, and runCount. dueAt must be a UTC timestamp ending
in Z; recurrence must be hourly, daily, weekly, or null; enabled is a boolean;
lastRunAt is nullable and, when present, must be a UTC timestamp ending in Z; and
runCount must be a nonnegative integer.
`;