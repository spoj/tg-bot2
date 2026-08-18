# tg-bot2

A small personal Telegram agent. The trusted TypeScript process owns the Telegram token and orchestration. Each chat has one long-lived Pi RPC worker inside Bubblewrap; the headless Pi process, native tools, Pi-managed extensions, and inner `bash` run there. The worker owns that chat's provider configuration and JSONL sessions.

## Requirements

- Linux with Bubblewrap (`bwrap`) and user namespaces enabled
- Node.js 22.19 or later and pnpm 11.17.0
- Host executables needed by workspace tools under `/usr` or `/bin`: `bash`, Node/npm, Python, `uv`, Git, curl, `rg`, and `jq`
- CA certificates under `/etc/ssl`, `/etc/pki`, or `/etc/ca-certificates`
- A Telegram bot token and workspace-owned Pi provider configuration
- Optional media tooling for installed multimodal extensions: `ffmpeg`/`ffprobe` for long audio and `yt-dlp` for YouTube URLs.

Example Debian/Ubuntu packages (names vary by distribution):

```sh
sudo apt install bubblewrap nodejs npm python3 git curl ripgrep jq ca-certificates
# Install uv system-wide so it is available under /usr or /bin.
corepack enable
```

## Setup and run

pnpm is the supported package manager.

```sh
pnpm install
cp .env.example .env
# Edit .env, then load it into the service environment:
set -a; . ./.env; set +a
pnpm run build
pnpm start
```

### systemd deployment backstop

`deploy/tg-bot2.service.example` is a unit example for running the built application. Copy it to a unit directory, edit every `EDIT REQUIRED` path/account value, and use a mode-0600 environment file containing `TG_BOT_TOKEN`, `ALLOWED_USER_IDS`, and `DATA_DIR`. After `pnpm run build`, the service entrypoint is `dist/src/index.js`. Keep Pi provider files in each chat workspace.

`KillMode=control-group` and a short `TimeoutStopSec` are service-level backstops: stopping the unit also stops detached Bubblewrap workers and their tool children. `CPUQuota`, `MemoryMax`, and `TasksMax` are aggregate cgroup limits for the trusted application and all workers together. The unit starts Node normally; it does not use `systemd-run`.

The unit intentionally does not add `ProtectSystem`, `PrivateNetwork`, or other systemd namespace restrictions. Bubblewrap owns the filesystem and namespace boundary for each worker, and its `--share-net` behavior is intentional.

Development: `pnpm run dev`. The service uses Telegram long polling. Private chats are intended. Data is namespaced by numeric `chat.id`; authorization uses numeric `from.id`.

`.tg-bot/events.jsonl` is the chat's single source of truth: the host appends every Telegram chat event to it (unbounded, append-only, newest last). Every line is `{v:1,t,...}` with an ISO-8601 `t`; inbound events embed Telegram's raw objects verbatim — user messages as `{type:'message',message,attachments}` (message is the raw Bot API Message object; attachments are files the host downloaded with `{type,path,mimeType,originalName}` or `{type,failure}`), button presses as `{type:'callback',callback_query}`, poll votes as `{type:'poll_answer',poll_answer}`. Messages and callbacks wake the worker: after a two-second quiet timer, the host prompts the worker with a single `.` and the agent reads the newest events and answers through the outbox. Poll answers are only logged. Common Telegram attachments are saved under `workspace/attachments/YYYY-MM-DD/<message-id>/` and Pi receives sandbox-visible `/workspace/...` paths with type, MIME …

If a user message arrives during an active run, it aborts the in-flight action — generation or tool call, matching Esc in Pi itself — and the next wake starts a fresh prompt; the aborted run never replies, so stale output cannot land after the user changed direction. `/new` establishes a per-chat ingress boundary: accepted earlier events drain first, later events wait until the new JSONL session starts, and older session files remain searchable. All Telegram output flows through one per-chat FIFO delivery queue: the agent writes requests to `.tg-bot/outbox/` and the host drains them in order, so same-chat sends retain production order, different chats can send concurrently, and one failed send does not block later sends. After each send the host appends a `send` line (`{v:1,t,type:'send',kind,id,messageId?,pollId?,ok,error?}`) to `events.jsonl`; the agent polls the log itself to correlate sends with their ids, including the `pollId` used to match poll answers. The scheduler still runs each due prompt through the agent as before, and its output is sent via the outbox like any other reply. Shutdown stops polling and producers, drains accepted ingress and outbound sends, and terminates workers.

### Telegram commands

The bot answers a few user-gated commands in private chats:

- `/model` — list available models (the current one is marked), or set one by a case-insensitive substring of its name or id, e.g. `/model claude`.
- `/thinking` — list available thinking levels (the current one is marked), or set one, e.g. `/thinking high`.
- `/status` — show the current model, thinking level, session file, and message count.
- `/restart` — restart the chat's Pi worker.

Model and thinking-level changes persist as user defaults in `.pi/agent/settings.json`. Authorization is enforced by `ALLOWED_USER_IDS`; provider credentials and model selection remain workspace-owned, and auth provisioning stays out-of-band: place the provider's Pi files under `DATA_DIR/chats/<numeric-chat-id>/workspace/.pi/agent/` before the first prompt.

## Configuration

Required:

- `TG_BOT_TOKEN`: Telegram bot token.
- `ALLOWED_USER_IDS`: comma-separated positive numeric Telegram user IDs. Missing, empty, zero, or malformed values fail startup; there is no allow-all mode.
- `DATA_DIR`: persistent host data root.

Pi provider credentials and model selection are workspace-owned. Before a chat's first prompt, place the selected provider's Pi files under `DATA_DIR/chats/<numeric-chat-id>/workspace/.pi/agent/` (typically `auth.json`, `models.json`, and `settings.json`). This is the chat's Pi user layer. The worker passes an empty host environment to Bubblewrap, so provider secrets are not inherited from the service. The old shared `.pi-runtime` layout is not migrated.

The workspace `.pi/` directory is the chat's project layer. Project settings and resources live under `.pi/`; `settings.json` and installed resources override user-layer resources where Pi allows it. Install optional extensions into this project layer with an explicit source and approval: `pi install npm:<package> -l --approve` for npm packages, `pi install https://... -l --approve` or `pi install git:... -l --approve` for git URLs, and `pi install ./... -l --approve` for local paths. Do not use a bare package name: Pi requires the `npm:` source form. In the non-interactive worker, use `pi list --approve` to inspect project-local packages. The base Pi CLI remains the only Pi package bundled by the application. The worker discovers resources from both `.pi/agent/` and `.pi/`. These are Pi precedence and lifecycle scopes, not an access-control boundary: the worker can read both.

Pi runs headless with `--mode rpc --approve` and exchanges newline-delimited JSON requests/events with the host. Optional extension behavior, including media analysis, is available only after its package is installed and may require provider consent. The host watches project and user extension resources, debounces changes, and reloads an idle worker after the current turn so newly installed or edited extensions load without a bot-wide restart.

Session lifecycle: every worker start begins a fresh session. The worker is stopped after 2 hours of chat inactivity; the next message starts a fresh worker. Older transcripts persist under `.pi/sessions/*.jsonl` for the agent to grep when the user references history.

### Configuration files

| Item | Single source of truth |
| --- | --- |
| `auth.json`, `models.json` | `.pi/agent/` only |
| `settings.json` | `.pi/agent/settings.json` (user defaults written by `/model` and `/thinking`); `.pi/settings.json` (project settings) |
| `AGENTS.md` | workspace root only — never `.pi/agent/AGENTS.md` |
| `models-store.json`, `run-history.jsonl`, `web-search.json`, `missions` | Pi-managed |
| `.pi/` project layer | project settings, package sources, and installed resources |

## Persistent layout

```text
DATA_DIR/chats/<numeric-chat-id>/
  workspace/                         # persistent writable worker bind
    .pi/agent/                       # Pi user config, auth, models, and user packages
    .pi/settings.json                # project settings and package sources
    .pi/npm/                         # project-scoped Pi packages
    .pi/extensions/                  # project-local extension files
    .pi/sessions/*.jsonl             # canonical Pi conversation files
    .tg-bot/schedules.json           # workspace-owned reminders
    .tg-bot/outbox/{*.json,processed,failed}/
    .tg-bot/events.jsonl             # chat state source of truth (host-written, append-only, unbounded)
    .tg-bot/poll-results.jsonl      # bounded stopped-poll results (latest 256 lines)
    attachments/YYYY-MM-DD/<message-id>/
    memory/                           # optional user-curated notes
    .cache/npm/ .cache/uv/ .local/ .python/
```

Normal files, workspace-local npm installs, Pi package installs, uv environments/tools, scripts, caches, attachments, schedules, outbox requests, and Pi sessions persist. Pi JSONL files are the session transcript; other workspace files are ordinary data. To send through Telegram, write one request (`{version:1,id,...}`) to `.tg-bot/outbox/` via a temporary non-`.json` file and atomic rename. Types: `send_file` (`{version:1,id,type:"send_file",path,caption?,kind?,reply_to_message_id?,disable_notification?}`) sends a workspace file; `kind` defaults to `auto` (extension detection: photos as photos, audio as audio, video as video, images over 10 MB and unknown types as documents) or an explicit `photo`/`audio`/`video`/`voice`/`document`. `send_message` (`{version:1,id,type:"send_message",text,parse_mode?,entities?,link_preview_options?,reply_markup?,reply_to_message_id?,disable_notification?}`) sends a text message with optional HTML/MarkdownV2 markup (malformed markup is resent as plain text; `parse_mode` and `entities` are mutually exclusive), message entities, link-preview options, inline-keyboard reply markup, a reply target, and silent sending. `send_location` (`{version:1,id,type:"send_location",latitude,longitude,horizontal_accuracy?,heading?,live_period?,venue?,reply_to_message_id?,disable_notification?}`) sends a location pin or venue. `send_poll` (`{version:1,id,type:"send_poll",question,options,is_anonymous?,allows_multiple_answers?,poll_type?,correct_option_id?,reply_to_message_id?,disable_notification?}`) sends a poll; non-anonymous poll answers are logged as `poll_answer` events, correlated with the `pollId` recorded in the send line in `events.jsonl`. `stop_poll` (`{version:1,id,type:"stop_poll",message_id,reply_markup?}`) closes a poll early and appends the final Poll as `{id,result}` to `.tg-bot/poll-results.jsonl`. `send_reaction` (`{version:1,id,type:"send_reaction",message_id,reaction}`) sets a reaction on any message in the chat (array of 1-3 {type:"emoji",emoji} or {type:"custom_emoji",custom_emoji_id} entries; empty array removes). `edit_message` (`{version:1,id,type:"edit_message",message_id,text?,parse_mode?,entities?,link_preview_options?,reply_markup?}`) edits one of the agent's earlier messages (at least one of text/reply_markup/link_preview_options required). `delete_message` (`{version:1,id,type:"delete_message",message_id}`) deletes one of the agent's earlier messages. Requested paths must remain in the workspace; processed and failed requests are archived in their corresponding directories.

Schedules are stored in `.tg-bot/schedules.json` with root `{version:1,schedules:[...]}`. Each record has `id`, `prompt`, `dueAt`, `recurrence`, `enabled`, `lastRunAt`, and `runCount`; timestamps are UTC and recurrence is hourly, daily, weekly, or `null`.

## Sandbox boundary

Node starts one detached `bwrap` process per chat worker; model commands are sent over RPC and native tools, extensions, and their child processes run inside that namespace.

- read-only: `/usr`, `/bin` and runtime libraries when present, and installed `node_modules` at `/app/node_modules`
- read-only, individually when present: `/etc/resolv.conf`, `/etc/hosts`, `/etc/ssl`, `/etc/pki`, `/etc/ca-certificates`
- private/synthetic: `/proc`, `/dev`, and tmpfs `/tmp`
- read/write: the assigned chat workspace at `/workspace`
- not mounted: host home, service source, host data root, or shared session directories

Workers unshare user, PID, IPC, and UTS namespaces, drop all capabilities, use a new session, and intentionally share the network. The security boundary is filesystem containment enforced by Bubblewrap/kernel, not protection from kernel exploits or hostile local-network services. The agent can exfiltrate anything it can read, destroy its workspace, and run arbitrary downloaded package code inside this boundary.

The worker sets `HOME=/workspace`, `TMPDIR=/tmp`, `PI_CODING_AGENT_DIR=/workspace/.pi/agent`, `PATH=/workspace/.local/bin:/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`, and workspace-local npm/uv cache and install paths. The `pi` CLI is available from the read-only application runtime, while installed packages persist in the writable project layer. Startup fails rather than falling back to unsandboxed execution if the data root is unwritable, Bubblewrap is unavailable, or the required runtime probe fails.

## Tests

```sh
pnpm run typecheck
pnpm test
RUN_BWRAP_TESTS=1 pnpm test
# or only the Linux integration suites:
pnpm run test:integration
```

Unit tests cover fail-closed configuration, canonical paths, response splitting and extraction, serialization, exact tool argv/stdin handling, attachment buffering and metadata, confined file delivery, symlink rejection, outbox recovery, scheduler persistence/recurrence/shutdown, Pi RPC lifecycle, and Bubblewrap argument construction. Opt-in Linux integration (`sandbox.test.ts` and `pi-integration.test.ts`) covers persistence, resource isolation, secret-free environment, bounded output, process timeout, and the real Pi CLI's RPC lifecycle.

For deployment, smoke-test provider authentication with workspace-owned Pi files, Pi restart/continue and `/new`, Telegram authorization and ordering, attachment downloads, outbox delivery, schedule recurrence, network access, npm/uv persistence, all required runtime commands, and an unmounted host canary on the target distribution.
