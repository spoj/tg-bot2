# tg-bot2

Persistent personal agent host. One workspace may contain multiple connector instances; each connector owns transport details while conversation agents share the workspace timeline and durable memory. The trusted host holds connector credentials, and turns run in a `pi --mode rpc` worker inside a Bubblewrap sandbox with mid-flight steering and follow-ups. Settled workers are reaped after two idle hours. Active turns are otherwise unbounded, but a queued user steer aborts the current operation after two minutes and immediately continues with that input.

## Requirements

- Linux with Bubblewrap, Node.js 22.19+, pnpm 11.17.0
- CA certificates and the workspace toolchain (bash, node/npm, python, uv, git, curl, rg, jq)

## Quick start

```sh
pnpm install
# Add a Telegram connector to workspace "main"
mkdir -p ~/.local/share/tg-bot2/workspaces/main/connectors
echo '{"token": "<TG_BOT_TOKEN>"}' > ~/.local/share/tg-bot2/workspaces/main/connectors/telegram-<botId>.json
chmod 600 ~/.local/share/tg-bot2/workspaces/main/connectors/telegram-<botId>.json
pnpm build
pnpm start
```

A single host loads every workspace under `$DATA_DIR/workspaces/` (defaults to `~/.local/share/tg-bot2`). Connector instances configured in one workspace share its writable `workspace/`, timeline, schedules, and agent runtime. Provider credentials go under `DATA_DIR/workspaces/<workspaceId>/workspace/.pi/agent/` before the first prompt. A systemd unit example lives at `deploy/tg-bot2.service.example`. Only the workspace-first layout is supported.

Attachment files live under `DATA_DIR/workspaces/<workspaceId>/attachments/`, in connector-specific subdirectories. The whole attachment tree, including partial downloads, has a 50 GiB hard cap. New attachments are rejected when they would exceed it, while completed files are never evicted automatically; remove old files manually when space is needed. Failed staging and failed Telegram deliveries clean up only the new staged files.

## Chat access

Telegram connectors in a workspace share its allow list at `DATA_DIR/workspaces/<workspaceId>/workspace/.allowed.json` (a JSON array of allowed chat IDs); the host enforces it for ingress, sends, and cross-conversation steering. An update from an unlisted chat is discarded without retaining content or its native payload. The timeline records at most one `telegram.access_request` per rejection reason, chat, update type, and process lifetime: private chats include bounded requester identity; bot group-adds include bounded group and inviter identity; other group activity includes only bounded group identity. Rejected updates are never queued or replayed after approval.

## Key entry points

- **Conversation agents** (`src/agent.ts`): each connector-native conversation owns one responsible RPC session. Identity is `{connectorId, conversationKey, address}`; connector code defines the address shape. User input steers its owner, while `steer_conversation` accepts a conversation object copied from the timeline. Notifications are journaled once per workspace, delivered in order, and acknowledged only after the Pi RPC worker accepts the complete prompt; unacknowledged notifications replay after restart. Each conversation can override connector attention defaults in its session-local `notifications.json`.
- **Connector boundary** (`src/connector.ts`, `src/telegram-connector.ts`): connectors parse and authorize native conversation addresses, dispatch native sends, format notifications, and define attention defaults. Telegram API details, allow-list checks, retries, attachment staging, and message/poll ownership remain inside the Telegram connector. The generic outbox, event router, agent manager, schedules, and bridge contain no Telegram destination fields.
- **Host protocol**: host-owned files are exposed read-only under `/run`: workspace-wide `timeline.jsonl`, `schedules.json`, `resources.json`, and connector-namespaced `attachments/`, plus the authenticated bridge socket. Timeline v2 events preserve connector-native payloads in `{connectorId,conversation,type,payload}` envelopes. Resource ownership is durable host state rather than reconstructed policy inside the timeline. `annotate` adds a searchable description to the original sent or received attachment.
- **Schedules and multimodal work**: the host assigns stable schedule IDs and owns `/run/schedules.json`. Conversation agents use `schedule_add`, `schedule_replace`, and `schedule_remove` for schedules they own; `schedule_take` freely moves responsibility to its caller without changing timing. When due, a schedule wakes its current owner, which acts directly or coordinates with `steer_conversation`. `ask_multimodal` (`extensions/multimodal.ts`) analyzes mixed media through an explicitly selected model; agents use `annotate` to preserve a short content description at the attachment's original timeline position.
- **Checks**: `pnpm check` builds the production output, then runs every gate (lint, typecheck, tests) in one command — the same command CI runs. `pnpm check --integration` adds the bwrap suite (needs bwrap and the bundled Pi CLI). Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.