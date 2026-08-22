# tg-bot2

Personal Telegram agent. The trusted host process owns the Telegram token; turns run in a `pi --mode rpc` worker inside a Bubblewrap sandbox that supports mid-flight steering, follow-ups, and a 10-minute idle reaper.

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

- **Agent entry points** (`src/agent.ts`): `followup(text)` delivers follow-up instructions via RPC `followUp` streaming behavior; `interrupt(text)` delivers mid-flight steering via RPC `steer` streaming behavior. Idle workers are reaped after 10 minutes of inactivity and restored on demand.
- **Host protocol** (host-owned log + synchronous bridge): `events.jsonl` lives at `DATA_DIR/bots/<botId>/events.jsonl` — outside the agent workspace. The host alone appends it: inbound Telegram messages/callbacks/votes (`chat_id` on each), and host outcomes (`outbox_sent`/`rejected`, `task_settled`, `task_progress`, `schedule_run_scheduled`/`fired`/`cancelled`, `allowlist_updated`, `chat_denied`, `browser_ready`/`browser_request_failed`/`browser_closed`). Workers read it read-only via a `--ro-bind` at `/workspace/.tg-bot/events.jsonl`. Agent tools (`send`/`spawn`/`steer_task`/`cancel`/`start_browser` registered by `extensions/host-tools.ts`) call the host synchronously over a UNIX socket bridge (`src/host-bridge.ts`) bind-mounted at `/workspace/.host/host.sock`; the host validates, executes, and returns the outcome in the tool result. Spawned tasks are host-minted UUID runs under `.pi/tasks/<runId>/` (up to 8 concurrent, excess queued in memory); boot reconciliation stamps crashed runs aborted, repairs settles lost mid-write, and relaunches fired schedule occurrences lost mid-fire. `.tg-bot/schedules.json` holds reminders as agent-owned rows (`prompt`, `start`, `recurrence` — `hourly`/`daily`/`weekly`/`null`).
- **Checks**: `pnpm check` runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.