# tg-bot2

A small personal Telegram agent. The trusted TypeScript process owns the Telegram token and orchestration. Every agent turn runs as a one-shot Pi `--print` process inside Bubblewrap — the process starts with a single prompt, runs the full tool loop, persists its session, and exits on its own; a live worker therefore always means an active run. The headless Pi process, native tools, Pi-managed extensions, and inner `bash` run inside the sandbox. Provider configuration and JSONL sessions are workspace-owned.

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

`.tg-bot/events.jsonl` is the chat's single source of truth: the host appends every Telegram chat event to it (unbounded, append-only, newest last). Every line is `{v:1,t,...}` with an ISO-8601 `t`; inbound events embed Telegram's raw objects verbatim — user messages as `{type:'message',message,attachments}` (message is the raw Bot API Message object; attachments are files the host downloaded with `{type,path,mimeType,originalName}` or `{type,failure}`), button presses as `{type:'callback',callback_query}`, poll votes as `{type:'poll_answer',poll_answer}`, send confirmations as `{type:'send',kind,id,messageId?,pollId?,data?}` (stop_poll results arrive as the `data` field), and outbox rejections as `{type:'outbox_rejected',detail}`. Messages, callbacks, and rejections wake the agent: after a two-second quiet timer, the host interrupts the chat with a single `.` and the agent reads the newest events and answers through the outbox. Poll answers are logged without waking the agent.

Every message to the agent goes through one of two host entry points. `interrupt` (user messages, outbox rejections) terminates the active one-shot run if any and starts a new one immediately; queued follow-ups survive and run afterward. `followup` (schedules) runs immediately when the chat is idle and queues behind the active run otherwise. An interrupted run never replies, so stale output cannot land after the user changed direction. All Telegram output flows through one per-chat FIFO delivery queue: the agent writes requests to `.tg-bot/outbox/` and the host drains them in order, so same-chat sends retain production order, different chats can send concurrently, and one failed send does not block later sends. After each successful send the host appends the confirmation event; rejected requests move to `outbox/failed/` and are reported as `outbox_rejected` events.

### Telegram commands

The bot answers a few user-gated commands in private chats:

- `/status` — show the current model, thinking level, session file, and message count (read from workspace files; no process is spawned).
- `/start` — introduction.

The command list is published to Telegram's client UI via `setMyCommands`. Model and thinking-level changes are made by the agent itself: it edits `.pi/agent/settings.json` (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`) and the values apply from the next run onward. Authorization is enforced by `ALLOWED_USER_IDS`; provider credentials and model selection remain workspace-owned, and auth provisioning stays out-of-band: place the provider's Pi files under `DATA_DIR/chats/<numeric-chat-id>/workspace/.pi/agent/` before the first prompt.

## Configuration

Required:

- `TG_BOT_TOKEN`: Telegram bot token.
- `ALLOWED_USER_IDS`: comma-separated positive numeric Telegram user IDs. Missing, empty, zero, or malformed values fail startup; there is no allow-all mode.
- `DATA_DIR`: persistent host data root.

Pi provider credentials and model selection are workspace-owned. Before a chat's first prompt, place the selected provider's Pi files under `DATA_DIR/chats/<numeric-chat-id>/workspace/.pi/agent/` (typically `auth.json`, `models.json`, and `settings.json`). This is the chat's Pi user layer. The worker passes an empty host environment to Bubblewrap, so provider secrets are not inherited from the service. The old shared `.pi-runtime` layout is not migrated.

The workspace `.pi/` directory is the chat's project layer. Project settings and resources live under `.pi/`; `settings.json` and installed resources override user-layer resources where Pi allows it. Install optional extensions into this project layer with an explicit source and approval: `pi install npm:<package> -l --approve` for npm packages, `pi install https://... -l --approve` or `pi install git:... -l --approve` for git URLs, and `pi install ./... -l --approve` for local paths. Do not use a bare package name: Pi requires the `npm:` source form. In the non-interactive worker, use `pi list --approve` to inspect project-local packages. The base Pi CLI remains the only Pi package bundled by the application. The worker discovers resources from both `.pi/agent/` and `.pi/`. These are Pi precedence and lifecycle scopes, not an access-control boundary: the worker can read both.

Pi runs headless with `--print --approve` for one turn per process: the host streams the single message into stdin, and the process persists the session and exits on its own — settlement is the exit itself, with no RPC or polling. The host passes `--continue` when the chat has activity within a 2-hour window, plus `--model <provider/id>` and `--thinking <level>` from `.pi/agent/settings.json` so settings edits always win over session-restored values. Optional extension behavior, including media analysis, is available only after its package is installed and may require provider consent. Settings and extension changes take effect on the next run; a malformed settings file fails the next run, so the agent is told to edit it atomically.

Session lifecycle: every run starts a fresh process, resumes the newest session file when activity is within the two-hour window, and otherwise starts a new session. To reset context deliberately, the agent touches `.tg-bot/new-session`; the host consumes the marker and starts fresh on the next run. Older transcripts persist under `.pi/sessions/*.jsonl` for the agent to grep when the user references history. The host keeps the per-chat last-activity time in `chats/<id>/activity.json`, outside the sandbox.

### Configuration files

| Item | Single source of truth |
| --- | --- |
| `auth.json`, `models.json` | `.pi/agent/` only |
| `settings.json` | `.pi/agent/settings.json` (user defaults, edited by the agent); `.pi/settings.json` (project settings) |
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
    .tg-bot/new-session                # agent-created marker for a deliberately fresh session
    attachments/YYYY-MM-DD/<message-id>/
    memory/                           # optional user-curated notes
    .cache/npm/ .cache/uv/ .local/ .python/
```

Normal files, workspace-local npm installs, Pi package installs, uv environments/tools, scripts, caches, attachments, schedules, outbox requests, and Pi sessions persist. Pi JSONL files are the session transcript; other workspace files are ordinary data. To send through Telegram, write one request (`{version:1,id,...}`) to `.tg-bot/outbox/` via a temporary non-`.json` file and atomic rename. Types: `send_file` (`{version:1,id,type:"send_file",path,caption?,kind?,reply_to_message_id?,disable_notification?}`) sends a workspace file; `kind` defaults to `auto` (extension detection: photos as photos, audio as audio, video as video, images over 10 MB and unknown types as documents) or an explicit `photo`/`audio`/`video`/`voice`/`document`. `send_message` (`{version:1,id,type:"send_message",text,parse_mode?,entities?,link_preview_options?,reply_markup?,reply_to_message_id?,disable_notification?}`) sends a text message with optional HTML/MarkdownV2 markup (malformed markup is resent as plain text; `parse_mode` and `entities` are mutually exclusive), message entities, link-preview options, inline-keyboard reply markup, a reply target, and silent sending. `send_location` (`{version:1,id,type:"send_location",latitude,longitude,horizontal_accuracy?,heading?,live_period?,venue?,reply_to_message_id?,disable_notification?}`) sends a location pin or venue. `send_poll` (`{version:1,id,type:"send_poll",question,options,is_anonymous?,allows_multiple_answers?,poll_type?,correct_option_id?,reply_to_message_id?,disable_notification?}`) sends a poll; non-anonymous poll answers are logged as `poll_answer` events, correlated with the `pollId` recorded in the send line in `events.jsonl`. `stop_poll` (`{version:1,id,type:"stop_poll",message_id,reply_markup?}`) closes a poll early and appends the final Poll as `{id,result}` to `.tg-bot/poll-results.jsonl`. `send_reaction` (`{version:1,id,type:"send_reaction",message_id,reaction}`) sets a reaction on any message in the chat (array of 1-3 {type:"emoji",emoji} or {type:"custom_emoji",custom_emoji_id} entries; empty array removes). `edit_message` (`{version:1,id,type:"edit_message",message_id,text?,parse_mode?,entities?,link_preview_options?,reply_markup?}`) edits one of the agent's earlier messages (at least one of text/reply_markup/link_preview_options required). `delete_message` (`{version:1,id,type:"delete_message",message_id}`) deletes one of the agent's earlier messages. Requested paths must remain in the workspace; processed and failed requests are archived in their corresponding directories.

Schedules are stored in `.tg-bot/schedules.json` with root `{version:1,schedules:[...]}`. Each record has `id`, `prompt`, `dueAt`, `recurrence`, `enabled`, `lastRunAt`, and `runCount`; timestamps are UTC and recurrence is hourly, daily, weekly, or `null`.

## Sandbox boundary

Node starts one detached `bwrap` process per agent run; the model and thinking level travel as CLI flags and native tools, extensions, and their child processes run inside that namespace.

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

Unit tests cover fail-closed configuration, canonical paths, response splitting and extraction, serialization, exact tool argv/stdin handling, attachment buffering and metadata, confined file delivery, symlink rejection, outbox recovery, scheduler persistence/recurrence/shutdown, the one-shot Pi run lifecycle, and Bubblewrap argument construction. Opt-in Linux integration (`sandbox.test.ts` and `pi-integration.test.ts`) covers persistence, resource isolation, secret-free environment, bounded output, process timeout, and the real Pi CLI's one-shot `--print` lifecycle.

For deployment, smoke-test provider authentication with workspace-owned Pi files, session resume across two-hour windows and fresh sessions via the `new-session` marker, Telegram authorization and ordering, attachment downloads, outbox delivery, schedule recurrence, network access, npm/uv persistence, all required runtime commands, and an unmounted host canary on the target distribution.
