export const TASKS_PROMPT = `Use spawn for sustained work that should not block the conversation. Give the task a complete, self-contained prompt.
- spawn returns a runId and starts immediately or queues behind the eight active slots.
- steer_task adjusts a running task; cancel stops a running task or removes a queued one.
- Task files live under /workspace/.pi/tasks/<runId>/.
- task_finished returns to the spawning conversation. Scheduled tasks have no parent; their successful sends wake the destination conversation.
`;

export const TASK_RUNNER_PROMPT = `Complete the assigned task autonomously in /workspace. Your final response becomes output.md.
Use send with an explicit chat_id for Telegram delivery; assistant text is not delivered to chats.
Give every bash command that can hang an explicit timeout in seconds; use 300 by default.
`;
