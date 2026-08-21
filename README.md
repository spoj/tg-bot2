# tg-bot2

Personal Telegram agent. The trusted host process owns the Telegram token; every agent turn is a one-shot `pi --print` process inside a Bubblewrap sandbox that persists its session and exits on its own.

## Requirements

- Linux with Bubblewrap, Node.js 22.19+, pnpm 11.17.0
- CA certificates and the workspace toolchain (bash, node/npm, python, uv, git, curl, rg, jq)

## Quick start

```sh
pnpm install
# Add a bot under ~/.local/share/tg-bot2/bots/<botId>/auth.json (or DATA_DIR/bots/<botId>/auth.json)
mkdir -p ~/.local/share/tg-bot2/bots/<botId>
echo '{"token": "<TG_BOT_TOKEN>"}' > ~/.local/share/tg-bot2/bots/<botId>/auth.json
chmod 600 ~/.local/share/tg-bot2/bots/<botId>/auth.json
pnpm build
pnpm start
```

A single instance listens to all bots found in `$DATA_DIR/bots/` (defaults to `~/.local/share/tg-bot2`). Provider credentials go under `DATA_DIR/bots/<botId>/workspace/.pi/agent/` before the first prompt. A systemd unit example lives at `deploy/tg-bot2.service.example`.

## Chat access

Each bot serves several Telegram chats — private chats and groups — from its own workspace. The bot's agent owns its allow list at `DATA_DIR/bots/<botId>/workspace/.tg-bot/allowed.json` (a JSON array of allowed chat IDs); the host enforces it in both directions.

## Key entry points

- **Agent entry points** (`src/agent.ts`): `followup(text)` queues behind the active run; `interrupt(text)` stops it (interrupt bursts within a two-second window coalesce into one stop), preserves queued follow-ups, and runs now. These are the only two ways the host talks to the agent.
- **Agent protocol** (one shared append-only log plus agent-owned files): `.tg-bot/events.jsonl` is the single timeline log both sides append to — inbound Telegram messages/callbacks/votes (`chat_id` on each), the agent's host commands (`send_request`, `spawn_request`, `cancel_request` via `send`/`spawn`/`cancel` tools registered by `extensions/host-tools.ts`), and the host's terminal outcome lines (`outbox_sent`/`rejected`, `task_settled`, `schedule_run_scheduled`/`fired`/`cancelled`, `allowlist_updated`, `chat_denied`). The host tails `events.jsonl` via the request bus (`src/request-bus.ts`), processes each command exactly once, and writes its terminal outcome. `.tg-bot/schedules.json` holds reminders as agent-owned rows (`prompt`, `start`, `recurrence` — the host never writes it).
- **Checks**: `pnpm check` runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.