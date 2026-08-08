# tg-bot2

A small personal Telegram agent. The trusted TypeScript process owns the Telegram token and orchestration. Each chat has one long-lived Pi RPC worker inside Bubblewrap; the headless Pi process, native tools, selected extensions, and inner `bash` run there. The worker owns that chat's provider configuration and JSONL sessions.

## Requirements

- Linux with Bubblewrap (`bwrap`) and user namespaces enabled
- Node.js 22.19 or later and pnpm 11.17.0
- Host executables needed by workspace tools under `/usr` or `/bin`: `bash`, Node/npm, Python, `uv`, Git, curl, `rg`, and `jq`
- CA certificates under `/etc/ssl`, `/etc/pki`, or `/etc/ca-certificates`
- A Telegram bot token and workspace-owned Pi provider configuration
- Optional media tooling for full multimodal support: `ffmpeg`/`ffprobe` for long audio and `yt-dlp` for YouTube URLs.

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

All non-command updates in a chat share an ingress buffer. Each update resets a two-second quiet timer; when it expires, ordered text, captions, attachments, and download failures are submitted as one logical request. Common Telegram attachments are saved under `workspace/attachments/YYYY-MM-DD/<message-id>/` and Pi receives sandbox-visible `/workspace/...` paths with type, MIME type, and original-name metadata. Telegram's Bot API download limit is 20 MB per file. Unsupported non-file messages are described textually.

If a request arrives during an active run, it is sent through Pi's native steering mechanism; the active run sends the eventual response. `/new` flushes the chat buffer, waits behind the active run, then starts a new JSONL session while leaving older files searchable. Replies, assistant progress, scheduled text, and outbox files use one per-chat FIFO delivery queue: same-chat sends retain production order, different chats can send concurrently, and one failed send does not block later sends. Shutdown stops polling and producers, drains accepted ingress and outbound sends, and terminates workers.

## Configuration

Required:

- `TG_BOT_TOKEN`: Telegram bot token.
- `ALLOWED_USER_IDS`: comma-separated positive numeric Telegram user IDs. Missing, empty, zero, or malformed values fail startup; there is no allow-all mode.
- `DATA_DIR`: persistent host data root.

Pi provider credentials and model selection are workspace-owned. Before a chat's first prompt, place the selected provider's Pi files under `DATA_DIR/chats/<numeric-chat-id>/workspace/.pi/agent/` (typically `auth.json`, `models.json`, and `settings.json`). The worker passes an empty host environment to Bubblewrap, so provider secrets are not inherited from the service. The old shared `.pi-runtime` layout is not migrated.

`settings.json` supports `defaultProvider`, a provider-local `defaultModel`, and `defaultThinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). The worker uses the exact chat workspace as its persistent Pi resource/config root and discovers skills from `.pi/skills/` and `.agents/skills/`.

The worker loads these selected extensions inside the same boundary: web access (`pi-web-access`), document parsing (`pi-docparser`), multimodal media proxy (`pi-multimodal-proxy`), and subagent delegation (`pi-subagents`). Pi runs headless with `--mode rpc --continue --approve` and exchanges newline-delimited JSON requests/events with the host; media analysis requires per-provider consent through `/multimodal-proxy consent ...`.

## Persistent layout

```text
DATA_DIR/chats/<numeric-chat-id>/
  workspace/                         # persistent writable worker bind
    .pi/agent/                       # Pi auth, models, and settings
    .pi/sessions/*.jsonl             # canonical Pi conversation files
    .tg-bot/schedules.json           # workspace-owned reminders
    .tg-bot/outbox/{*.json,processed,failed}/
    attachments/YYYY-MM-DD/<message-id>/
    memory/                           # optional user-curated notes
    .cache/npm/ .cache/uv/ .local/ .python/
```

Normal files, workspace-local npm installs, uv environments/tools, scripts, caches, attachments, schedules, outbox requests, and Pi sessions persist. Pi JSONL files are the session transcript; other workspace files are ordinary data. To send a file, write a unique `send_file` request (`{version:1,id,type:"send_file",path,caption?}`) to `.tg-bot/outbox/` via a temporary non-`.json` file and atomic rename. The requested path must remain in the workspace; processed and failed requests are archived in their corresponding directories.

Schedules are stored in `.tg-bot/schedules.json` with root `{version:1,schedules:[...]}`. Each record has `id`, `prompt`, `dueAt`, `recurrence`, `enabled`, `lastRunAt`, and `runCount`; timestamps are UTC and recurrence is hourly, daily, weekly, or `null`.

## Sandbox boundary

Node starts one detached `bwrap` process per chat worker; model commands are sent over RPC and native tools, extensions, and their child processes run inside that namespace.

- read-only: `/usr`, `/bin` and runtime libraries when present, and installed `node_modules` at `/app/node_modules`
- read-only, individually when present: `/etc/resolv.conf`, `/etc/hosts`, `/etc/ssl`, `/etc/pki`, `/etc/ca-certificates`
- private/synthetic: `/proc`, `/dev`, and tmpfs `/tmp`
- read/write: the assigned chat workspace at `/workspace`
- not mounted: host home, service source, host data root, or shared session directories

Workers unshare user, PID, IPC, and UTS namespaces, drop all capabilities, use a new session, and intentionally share the network. The security boundary is filesystem containment enforced by Bubblewrap/kernel, not protection from kernel exploits or hostile local-network services. The agent can exfiltrate anything it can read, destroy its workspace, and run arbitrary downloaded package code inside this boundary.

The worker sets `HOME=/workspace`, `TMPDIR=/tmp`, `PI_CODING_AGENT_DIR=/workspace/.pi/agent`, `PATH=/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin`, and workspace-local npm/uv cache and install paths. Startup fails rather than falling back to unsandboxed execution if the data root is unwritable, Bubblewrap is unavailable, or the required runtime probe fails.

## Tests

```sh
pnpm run typecheck
pnpm test
RUN_BWRAP_TESTS=1 pnpm test
# or only the Linux integration suite:
pnpm run test:integration
```

Unit tests cover fail-closed configuration, canonical paths, response splitting and extraction, serialization, exact tool argv/stdin handling, attachment buffering and metadata, confined file delivery, symlink rejection, outbox recovery, scheduler persistence/recurrence/shutdown, Pi RPC lifecycle, and Bubblewrap argument construction. Opt-in Linux integration covers persistence, resource isolation, secret-free environment, bounded output, and process timeout.

For deployment, smoke-test provider authentication with workspace-owned Pi files, Pi restart/continue and `/new`, Telegram authorization and ordering, attachment downloads, outbox delivery, schedule recurrence, network access, npm/uv persistence, all required runtime commands, and an unmounted host canary on the target distribution.
