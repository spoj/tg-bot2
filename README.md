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

- **Agent entry points** (`src/agent.ts`): `followup(chatId, text)` queues behind the active run; `interrupt(chatId, text)` kills it, preserves queued follow-ups, and runs now. These are the only two ways the host talks to the agent.
- **Agent protocol** (workspace files): `.tg-bot/events.jsonl` is the chat event log; `.tg-bot/outbox/*.json` are Telegram sends; every dispatch is archived to `.tg-bot/sent.jsonl` or `.tg-bot/failed.jsonl`; `.tg-bot/schedules.json` holds reminders. Sessions persist under `.pi/sessions/*.jsonl`, resume within a two-hour inactivity window, and restart fresh when the agent touches `.tg-bot/new-session`. Model and thinking level are chosen by editing `.pi/agent/settings.json`.
- **Host commands**: `/status` and `/start` (published via `setMyCommands`); everything else the agent does itself.
- **Tests**: `pnpm typecheck`, `pnpm test`, `RUN_BWRAP_TESTS=1 pnpm test` (needs bwrap and the bundled Pi CLI).