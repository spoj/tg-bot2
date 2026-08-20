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
- **Agent protocol** (two append-only logs plus one agent-owned file): the agent's own Pi session files under `.pi/sessions/` and `.pi/tasks/<uuid>/sessions/` are its append-only record, and the host consumes host tool calls — `send`, `spawn`, `cancel` — from them via the session bus (`src/session-bus.ts`), claiming each call in `.tg-bot/system.jsonl` before acting. The tools themselves are no-op tools registered by the host-owned extension `extensions/host-tools.ts`, read-only-mounted at `/app/extensions/host-tools.ts` and enabled per run by the `PI_HOST_TOOLS` env var (chat runs: `send,spawn,cancel`; task runs: `send` only) — never agent-editable. `.tg-bot/system.jsonl` records every host-side state transition — task claims/settlements/cancels, outbox claims/sends/rejections (full request and raw Telegram response payloads), and schedule runs (`schedule_run_scheduled`/`fired`/`cancelled`, UUID-keyed occurrences materialized from the rows) — each referencing the source tool call by `(sessionId, recordId, index)`; `.tg-bot/chat.jsonl` mirrors the Telegram chat window (messages, button presses, poll votes, send confirmations); `.tg-bot/schedules.json` holds reminders as agent-owned rows (`prompt`, `start`, `recurrence` — the host never writes this file; each occurrence fires via the event log). Spawned tasks run as fresh Pi agents with their own sessions under `.pi/tasks/<uuid>/` (prompt.txt, output.md, sessions/, result.json), up to 8 concurrent per chat, and always settle exactly once (`done`/`failed`/`aborted`; aborted covers cancels and host restarts mid-run, stamped at boot); task agents can `send` Telegram messages, and the chat agent gets a heartbeat followup every 5 minutes while tasks run — silent otherwise.
- **Checks**: `pnpm check` runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.