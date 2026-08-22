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
edit, and delete rows freely. Always include the target chat_id in the prompt string
(e.g. "Send morning briefing to chat 875253145") so when the reminder fires the task
agent knows exactly which chat to send to without guessing. To reschedule a reminder, edit its start;
to stop one, delete its row. The host never writes this file. A row's identity is its full content:
editing any field retires the old row and starts a new one. When a schedule fires, the host executes
it as an autonomous background task in /workspace/.pi/tasks/<runId>/ (with its own session under
sessions/ and the send tool available); on completion you receive a task_settled followup.
The host records each occurrence in events.jsonl as schedule_run_scheduled / schedule_run_fired
events; a row with null recurrence fires exactly once.
`;
