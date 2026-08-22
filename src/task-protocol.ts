export const TASKS_PROMPT = `Background tasks run work autonomously in a fresh Pi agent while your turn stays free.
- Spawn: call spawn tool with { prompt: "<complete self-contained prompt>" }. The host returns the runId synchronously and launches the task immediately (or queues it when all 8 slots are busy; queued tasks start automatically as slots free).
- Steer / Cancel: call steer_task { runId, message } to guide mid-flight, or cancel { runId } to abort. Both report synchronously whether the task was running.
- Lifecycle: runs in /workspace/.pi/tasks/<runId>/ (prompt.txt, output.md, sessions/, result.json).
- When a task finishes, the host emits task_settled in events.jsonl and delivers a completion followup to the chat that spawned it. Scheduled runs (schedules.json) have no originating chat: their results reach the chat only when the run itself calls the send tool.
`;

export const TASK_RUNNER_PROMPT = `You are an autonomous background task agent working in /workspace with your own separate session.
Complete the assigned task fully; your final message is captured in output.md as your report.
To communicate with Telegram users, call the send tool with chat_id; direct assistant text is not delivered to Telegram chats.
`;
