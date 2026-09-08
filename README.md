# tg-bot2

Persistent personal agent host. A workspace may contain multiple connector instances; its conversation agents share files, a timeline, and one Pi profile. The trusted host holds connector credentials and runs `pi --mode rpc` workers inside Bubblewrap. Settled workers are reaped after two idle hours. Active turns are otherwise unbounded, but a queued user steer aborts the current operation after two minutes and immediately continues with that input.

## Requirements

- Linux with Bubblewrap, Node.js 22.19+, pnpm 11.17.0
- CA certificates and the workspace toolchain (bash, node/npm, python, uv, git, curl, rg, jq)

## Quick start

```sh
pnpm install
DATA_DIR="${DATA_DIR:-$HOME/.local/share/tg-bot2}"
BOT_DIR="$DATA_DIR/workspaces/main"
AGENT_DIR="$BOT_DIR/workspace/.pi/agent"
mkdir -p "$BOT_DIR/connectors" "$AGENT_DIR"
echo '{"token": "<TG_BOT_TOKEN>"}' > "$BOT_DIR/connectors/telegram-<botId>.json"
chmod 600 "$BOT_DIR/connectors/telegram-<botId>.json"
# Authenticate this profile with /login, then /quit.
PI_CODING_AGENT_DIR="$AGENT_DIR" ./node_modules/.bin/pi --no-approve
pnpm build
pnpm start
```

A single host loads every workspace under `$DATA_DIR/workspaces/`. Run provisioning and the service as the same OS account. The sandbox does not inherit host API-key environment variables or your personal `~/.pi/agent`; configure model credentials in the workspace profile. See Pi's bundled `docs/providers.md` for authentication options. A systemd example lives at `deploy/tg-bot2.service.example`.

## One workspace, one Pi profile

Inside a worker, `HOME=/workspace` and `PI_CODING_AGENT_DIR=/workspace/.pi/agent`. All conversation agents in that workspace share this profile. It is entirely agent-owned, including credentials and sessions; ownership is not split between `.pi` and `.pi/agent`.

| Path inside the worker | Purpose |
|---|---|
| `/workspace/.pi/agent/settings.json` | All Pi settings, including model, thinking, packages, and extension settings |
| `/workspace/.pi/agent/auth.json` | Model credentials |
| `/workspace/.pi/agent/models.json`, `models-store.json` | Custom models and cached catalogs |
| `/workspace/.pi/agent/AGENTS.md`, `/workspace/AGENTS.md` | Agent-owned instructions; Pi loads both when present |
| `/workspace/.pi/agent/extensions`, `skills`, `prompts`, `themes` | Agent-owned Pi resources |
| `/workspace/.pi/agent/npm`, `git` | Installed Pi packages |
| `/workspace/.pi/sessions/` | Writable conversation sessions and per-conversation `notifications.json` |

There are **no tg-bot2 bot defaults or seed files**. Absent configuration uses Pi's built-in defaults. The host creates runtime directories, but does not copy instructions, install a recommended package set, migrate settings, or force model, thinking, steering, or follow-up preferences.

Workers use `--no-approve`: `/workspace/.pi/settings.json` is ignored and project-local resource discovery is disabled, even if old files remain. Do not use a second settings file or `pi install -l`. Use `pi --no-approve install <source>`, `pi --no-approve update --extensions`, and `pi --no-approve update --models` to install packages, update packages, and refresh catalogs without loading project configuration. The Pi CLI itself is pinned by this repository and mounted read-only, not updated by the bot.

Set startup preferences in `/workspace/.pi/agent/settings.json` using `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`. Pi settings, packages, and context files are loaded by new workers. Telegram `/restart` closes all workers in the workspace; the next input creates a fresh session using the current profile. Existing sessions remain on disk. Notification overrides are read for each event and need no restart.

### What the host supplies

The only tg-bot2 additions to Pi are:

- The appended runtime instructions: workspace paths, host protocol, connector instructions, and the conversation's notification-settings path.
- `extensions/host-tools.ts`, mounted read-only and explicitly loaded for every conversation worker.

These are not profile defaults and are not managed through `settings.json`. Update them in the repository, rebuild, and restart the host service. Generated `.prompts/` files are runtime artifacts, not editable prompt sources. Because the host passes an explicit append prompt, Pi does not load `APPEND_SYSTEM.md`; use `AGENTS.md` for agent-owned instructions.

The host's sandbox, authenticated bridge, and connector checks enforce access; prompt text describes that contract. `/run` exposes host-owned state read-only, and `/workspace/node_modules` exposes host dependencies read-only. The rest of the workspace is writable.

### Upgrading an existing workspace

Before deploying the single-profile runtime:

1. Merge the old `.pi/settings.json` into `.pi/agent/settings.json`, preserving the old project values where they override profile values. Remove `.pi/settings.json` afterward.
2. Move project-local packages into the profile. For other Pi resources, move them under the profile or explicitly register their existing paths in the profile settings. Rebase any project-relative paths.
3. Review existing `AGENTS.md` files for obsolete settings paths or copied host instructions. Preserve agent-specific behavior and user preferences; do not replace the profile wholesale.

Auth, catalogs, sessions, and other workspace data need no reset. There is no automatic migration or subsequent synchronization with repository files.

## Chat access and attachments

Telegram connectors in a workspace share its allow list at `$DATA_DIR/workspaces/<workspaceId>/workspace/.allowed.json` (a JSON array of allowed chat IDs). The host enforces it for ingress, sends, and cross-conversation steering. An update from an unlisted chat is discarded without retaining content or its native payload. The timeline records at most one `telegram.access_request` per rejection reason, chat, update type, and process lifetime: private chats include bounded requester identity; bot group-adds include bounded group and inviter identity; other group activity includes only bounded group identity. Rejected updates are never queued or replayed after approval.

Attachments live under `$DATA_DIR/workspaces/<workspaceId>/attachments/`, in connector-specific subdirectories. The whole attachment tree, including partial downloads, has a 50 GiB hard cap. New attachments are rejected when they would exceed it; completed files are never evicted automatically. Failed staging and failed deliveries clean up only the new staged files.

## Key entry points

- **Conversation agents** (`src/agent.ts`): each connector-native conversation owns one responsible RPC session. Identity is `{connectorId, conversationKey, address}`. Notifications are journaled once per workspace, delivered in order, and acknowledged only after the Pi worker accepts the complete prompt; unacknowledged notifications replay after restart.
- **Connectors** (`src/connector.ts`, `src/telegram-connector.ts`): parse and authorize conversation addresses, dispatch sends, format notifications, and define attention defaults. Telegram API details, access checks, retries, attachment staging, and message/poll ownership stay inside the connector.
- **Host protocol**: `/run` exposes `timeline.jsonl`, `schedules.json`, `resources.json`, `attachments/`, and the authenticated bridge socket. Timeline v2 events preserve connector-native payloads in `{connectorId,conversation,type,payload}` envelopes. Resource ownership is durable host state, bounded to the newest 65,536 rows; old mutations or replies can fail after ownership is pruned. `annotate` appends an attachment description without rewriting prior records.
- **Schedules**: the host assigns stable schedule IDs. Conversation agents use `schedule_add`, `schedule_replace`, and `schedule_remove` for schedules they own; `schedule_take` moves responsibility to its caller without changing timing. Due schedules wake their current owner, which acts directly or coordinates through `steer_conversation`.
- **Checks**: `pnpm check` builds, then runs lint, typecheck, and tests—the same gates as CI. `pnpm check --integration` adds the Bubblewrap suite. Individual gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
