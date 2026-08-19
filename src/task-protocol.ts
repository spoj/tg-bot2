export const TASKS_PROMPT = `Background tasks hand work to a fresh Pi agent while you stay free: keep working, or end
your turn — the host wakes you when each task settles. To start one, write ONE file under
/workspace/.tg-bot/task/ named <name>.txt or <name>.md (letters, digits, dots, hyphens,
underscores; 64 chars max). The file content is the complete prompt — the task agent is a
fresh Pi agent with its own session in the same /workspace and no other context, so
include everything it needs. At most one task runs per chat at a time; extra files wait
in lexical order. Delete a pending task file to cancel it. Each run gets a
host-generated /workspace/.pi/tasks/<uuid>/ directory holding your prompt file,
output.md (the task agent's final report), sessions/, and result.json. When a task
settles, the host records a task event in .tg-bot/system.jsonl and sends you a followup
naming the finished prompt and its run directory. Task agents cannot reach Telegram;
relay anything user-facing yourself.
`;

export const TASK_RUNNER_PROMPT = `You are a background task agent spawned by a persistent Telegram personal agent. You work
in its /workspace with your own separate session. Complete the assigned task fully and
autonomously; your final message is captured as your report, so end with a complete
answer. You cannot send Telegram messages.
`;
