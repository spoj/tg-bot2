# tg-bot2

Personal Telegram agent. The trusted host process owns the Telegram token; turns run in a `pi --mode rpc` worker inside a Bubblewrap sandbox that supports mid-flight steering and follow-ups. Settled workers are reaped after two idle hours. Active turns are otherwise unbounded, but a queued user steer aborts the current operation after two minutes and immediately continues with that input.

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

Each bot serves several Telegram chats — private chats and groups — from its own workspace. The bot's agent owns its allow list at `DATA_DIR/bots/<botId>/workspace/.allowed.json` (a JSON array of allowed chat IDs); the host enforces it in both directions.

## Key entry points

- **Conversation agents** (`src/agent.ts`): each `(chat_id, message_thread_id)` owns one responsible RPC session and is the only identity allowed to send or mutate messages in that conversation. User input steers it; `steer_conversation` lets one conversation owner wake another without writing to Telegram. Notifications are journaled under `.pi/notifications.jsonl`, delivered in order, and acknowledged only after the Pi RPC worker accepts the complete prompt; unacknowledged notifications replay after restart. Settled workers idle for 2 hours before reaping. If a queued user steer waits 2 minutes, the host aborts the current operation so Pi can consume the original queued instruction.
- **Host protocol** (shared timeline + authenticated bridge): host-owned files are exposed outside the writable workspace directly under `/run`: the bot-global read-only `timeline.jsonl`, `schedules.json`, read-only `attachments/`, and bridge sockets. Persisted timeline events carry stable IDs and monotonic sequence numbers. The timeline contains accepted Telegram activity, successful owned actions, task finishes, and schedule firings; it also rebuilds message and poll ownership after restart. Agent tools call the bridge with a capability token bound to a typed conversation/task identity. `annotate` retroactively adds a searchable description to the original sent or received attachment object. Anonymous tasks receive only `annotate`; they cannot send, steer, or manage schedules.
- **Schedules and multimodal work**: the host assigns stable schedule IDs and owns `/run/schedules.json`. Conversation agents use `schedule_add`, `schedule_replace`, and `schedule_remove` for schedules they own; `schedule_take` freely moves responsibility to its caller without changing timing. When due, a schedule wakes its current owner, which acts directly or delegates with `spawn` or `steer_conversation`. `ask_multimodal` (`extensions/multimodal.ts`) analyzes mixed media through an explicitly selected model; agents use `annotate` to preserve a short content description at the attachment's original timeline position.
- **Checks**: `pnpm check` runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.