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
- **Agent protocol** (workspace files): `.tg-bot/chat.jsonl` mirrors the Telegram chat window (messages, button presses, poll votes, outbox sends); `.tg-bot/system.jsonl` records every host-side state transition — task claims and settlements, outbox claims/sends/rejections (full request and raw Telegram response payloads), and schedule runs (`schedule_run_scheduled`/`fired`/`cancelled`, UUID-keyed occurrences materialized from the rows); `.tg-bot/outbox/*.json` are Telegram sends; `.tg-bot/schedules.json` holds reminders as agent-owned rows (`prompt`, `start`, `recurrence` — the host never writes this file; each occurrence fires via the event log); `.tg-bot/task/*.txt|md` files start background tasks — fresh Pi agents with their own sessions under `.pi/tasks/<uuid>/` (prompt file, output.md, sessions/, result.json), up to 8 concurrent per chat — which always settle exactly once (`done`/`failed`/`aborted`; aborted also covers host restarts mid-run, stamped at the…
- **Checks**: `pnpm check` runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.