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

- **Conversation agents** (`src/agent.ts`): each `(chat_id, message_thread_id)` owns one responsible RPC session and is the only identity allowed to send or mutate messages in that conversation. User input steers it; `steer_conversation` lets one conversation owner wake another without writing to Telegram. Settled workers idle for 2 hours before reaping. If a user steer remains queued for 2 minutes, the host aborts the current operation and queues an immediate continuation so long-running tools cannot make the chat unresponsive.
- **Host protocol** (shared timeline + authenticated bridge): host-owned files are exposed outside the writable workspace directly under `/run`: the bot-global read-only `timeline.jsonl`, read-only `attachments/`, and bridge sockets. The timeline contains accepted Telegram activity, successful owned actions, task finishes, and schedule firings; it also rebuilds message and poll ownership after restart. Agent tools call the bridge with a capability token bound to a typed conversation/task identity. `annotate` retroactively adds a searchable description to the original sent or received attachment object. Anonymous tasks receive only `annotate`; they cannot send or steer and communicate through settlement artifacts.
- **Schedules and multimodal work**: `.schedules.json` rows require an `origin` conversation. Due schedules run as anonymous tasks, then wake that origin to inspect their output and handle user communication. `ask_multimodal` (`extensions/multimodal.ts`) analyzes mixed media through an explicitly selected model; agents use `annotate` to preserve a short content description at the attachment's original timeline position.
- **Checks**: `pnpm check` runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.