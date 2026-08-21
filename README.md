# tg-bot2

Personal Telegram agent. The trusted host process owns the Telegram token; every agent turn is a one-shot `pi --print` process inside a Bubblewrap sandbox that persists its session and exits on its own.

## Requirements

- Linux with Bubblewrap, Node.js 22.19+, pnpm 11.17.0
- CA certificates and the workspace toolchain (bash, node/npm, python, uv, git, curl, rg, jq)

## Quick start

```sh
pnpm install
cp .env.example .env        # TG_BOT_TOKEN, DATA_DIR
set -a; . ./.env; set +a
pnpm build
pnpm start
```

Provider credentials go under `DATA_DIR/workspace/.pi/agent/` before the first prompt. A systemd unit example lives at `deploy/tg-bot2.service.example`.

## Chat access

One agent serves several Telegram chats — private chats and groups — from one workspace. The agent owns its allow list at `DATA_DIR/workspace/.tg-bot/allowed.json`; the host enforces it in both directions. The first chat that ever messages the bot is added automatically, and the agent manages every later change.

## Key entry points

- **Agent entry points** (`src/agent.ts`): `followup(text)` queues behind the active run; `interrupt(text)` stops it (interrupt bursts within a two-second window coalesce into one stop), preserves queued follow-ups, and runs now. These are the only two ways the host talks to the agent.
- **Agent protocol** (one shared append-only log plus agent-owned files): `.tg-bot/events.jsonl` is the single timeline log both sides append to — inbound Telegram messages/callbacks/votes (`chat_id` on each), the agent's host commands (`send_request`, `spawn_request`, `cancel_request` via `send`/`spawn`/`cancel` tools registered by `extensions/host-tools.ts`), and the host's terminal outcome lines (`outbox_sent`/`rejected`, `task_settled`, `schedule_run_scheduled`/`fired`/`cancelled`, `chat_allowed`/`denied`). The host tails `events.jsonl` via the request bus (`src/request-bus.ts`), processes each command exactly once, and writes its terminal outcome. `.tg-bot/schedules.json` holds reminders as agent-owned rows (`prompt`, `start`, `recurrence` — the host never writes this file); `.tg-bot/allowed.json` is the agent-owned chat allow list the host enforces on both inbound messages and outbound sends. Spawned tasks run as fresh Pi agents with their own sessions under `.pi/tasks/<runId>/` (prompt.txt, output.md, sessions/, result.json), up to 8 concurrent, and always settle exactly once (`done`/`failed`/`aborted`; aborted covers cancels and host restarts mid-run, stamped at boot); task agents can `send` Telegram messages, and the chat agent gets a heartbeat followup every 5 minutes while tasks run — silent otherwise.
- **Checks**: `pnpm check` runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.