# tg-bot2

Personal Telegram agent. The trusted host process owns the Telegram token; every agent turn is a one-shot `pi --print` process inside a Bubblewrap sandbox that persists its session and exits on its own.

## Requirements

- Linux with Bubblewrap, Node.js 22.19+, pnpm 11.17.0
- CA certificates and the workspace toolchain (bash, node/npm, python, uv, git, curl, rg, jq)

## Quick start

```sh
pnpm install
cp .env.example .env        # TG_BOT_TOKEN, ALLOWED_USER_IDS, DATA_DIR
set -a; . ./.env; set +a
pnpm build
pnpm start
```

Provider credentials go under `DATA_DIR/chats/<chat-id>/workspace/.pi/agent/` before the first prompt. A systemd unit example lives at `deploy/tg-bot2.service.example`.

## Key entry points

- **Agent entry points** (`src/agent.ts`): `followup(chatId, text)` queues behind the active run; `interrupt(chatId, text)` stops it (interrupt bursts within a two-second window coalesce into one stop), preserves queued follow-ups, and runs now. These are the only two ways the host talks to the agent.
- **Agent protocol** (one shared append-only log plus one agent-owned file): `.tg-bot/system.jsonl` is the command-and-outcome log both sides append to — the agent's host tools (`send`, `spawn`, `cancel`, registered by the host-owned extension `extensions/host-tools.ts`, read-only-mounted at `/app/extensions/host-tools.ts` and enabled per run by `PI_HOST_TOOLS`; chat runs: all three, task runs: `send` only) mint a UUID per command, append `send_request`/`spawn_request`/`cancel_request` lines, and return the UUID to the agent in-context; the host tails the same log via the request bus (`src/request-bus.ts`), claims each command in the log before acting, and appends the outcome lines — `outbox_claimed`/`sent`/`rejected`, `task_claimed`/`settled`/`cancelled`, and `schedule_run_scheduled`/`fired`/`cancelled` (UUID-keyed occurrences materialized from the agent-owned rows). Every command is processed exactly once: claims dedupe, open outbox claims resume at boot. `.tg-bot/chat.jsonl` mirrors the Telegram chat window (messages, button presses, poll votes, send confirmations); `.tg-bot/schedules.json` holds reminders as agent-owned rows (`prompt`, `start`, `recurrence` — the host never writes this file). Spawned tasks run as fresh Pi agents with their own sessions under `.pi/tasks/<runId>/` (prompt.txt, output.md, sessions/, result.json), up to 8 concurrent per chat, and always settle exactly once (`done`/`failed`/`aborted`; aborted covers cancels and host restarts mid-run, stamped at boot); task agents can `send` Telegram messages, and the chat agent gets a heartbeat followup every 5 minutes while tasks run — silent otherwise.
- **Checks**: `pnpm check` runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.