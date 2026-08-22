export type Recurrence = "hourly" | "daily" | "weekly";

export type ScheduleRow = {
  prompt: string;
  start: string;
  recurrence: Recurrence | null;
};

export const SCHEDULES_PROMPT = `Schedules live in /workspace/.tg-bot/schedules.json: {version:1,schedules:[{prompt,start,recurrence}]}.
- prompt: instructions for the task agent (include target chat_id, e.g. "Send morning briefing to chat 875253145").
- start: first firing time (UTC ISO-8601 ending in 'Z').
- recurrence: "hourly", "daily", "weekly", or null (one-shot).
You own this file; edit rows freely. When due, the host spawns an autonomous background task in /workspace/.pi/tasks/<runId>/ (reusing the schedule's runId); on completion you receive a task_settled followup.
`;
