export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleRow = {
  prompt: string;
  start: string;
  recurrence: Recurrence | null;
};

export const SCHEDULES_PROMPT = `Schedules live in /workspace/.tg-bot/schedules.json. Its root object is
{version:1,schedules:[...]}. Each row has three fields: prompt (a non-empty string, at most
16384 characters), start (the first firing time, a UTC timestamp ending in Z), and
recurrence (hourly, daily, weekly, or null for a one-shot). You own this file: create,
edit, and delete rows freely. To reschedule a reminder, edit its start; to stop one,
delete its row. The host never writes this file. A row's identity is its full content:
editing any field retires the old row and starts a new one. When the host sends you a
followup that is exactly one of your schedule prompts, that reminder is firing now: do
what the prompt says. The host records each occurrence in system.jsonl as
schedule_run_scheduled / schedule_run_fired events; a row with null recurrence fires
exactly once.
`;
