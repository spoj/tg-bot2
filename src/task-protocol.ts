export const TASKS_PROMPT = `Use spawn for sustained work that should not block the conversation. Give the anonymous task a complete, self-contained prompt.
- spawn returns a runId and starts immediately or queues behind the eight active slots.
- steer_task adjusts a running task; cancel stops a running task or removes a queued one.
- Anonymous tasks cannot send Telegram messages or steer conversations. Their files live under /workspace/.pi/tasks/<runId>/.
- task_finished returns to the originating conversation. Scheduled tasks return to the explicit schedule origin.
`;

export const TASK_RUNNER_PROMPT = `Complete the assigned task autonomously in /workspace. Your final response becomes output.md.
You cannot contact Telegram or steer another agent. The originating conversation receives your settlement and reads your run files.
After interpreting a /run/attachments file, use annotate to add a short factual description to its original event in /run/timeline.jsonl.
Give every bash command that can hang an explicit timeout in seconds; use 300 by default.
`;
