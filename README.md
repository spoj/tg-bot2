# tg-bot2

A small personal Telegram agent. The trusted TypeScript process owns the Telegram token and orchestration; each Pi worker owns its chat's provider configuration and JSONL sessions. Every model-facing `read`, `write`, `grep`, and `bash` call starts the same Bubblewrap filesystem sandbox.

## Requirements

- Linux with Bubblewrap (`bwrap`) and user namespaces enabled
- Node.js 22.19 or later and pnpm 11.17.0
- Host executables available below `/usr` or `/bin`: `bash`, Node/npm, Python, `uv`, Git, curl, `rg`, and `jq`
- CA certificates under `/etc/ssl`, `/etc/pki`, or `/etc/ca-certificates`
- A Telegram bot token and workspace-owned Pi provider configuration

Example Debian/Ubuntu packages (package names vary by distribution):

```sh
sudo apt install bubblewrap nodejs npm python3 git curl ripgrep jq ca-certificates
# Install uv system-wide so it is available under /usr or /bin.
# Enable the pnpm version declared by package.json.
corepack enable
```

## Setup and run

pnpm is the supported package manager for this repository.

```sh
pnpm install
cp .env.example .env
# Edit .env, then load it into the service environment:
set -a; . ./.env; set +a
pnpm run build
pnpm start
```

### systemd deployment backstop

`deploy/tg-bot2.service.example` is a service-unit example for running the built application under systemd. Copy it to a unit directory, edit every `EDIT REQUIRED` path/account value, and make the referenced mode-0600 environment file contain `TG_BOT_TOKEN`, `ALLOWED_USER_IDS`, and `DATA_DIR`. Keep Pi provider files in each chat workspace.

The unit's `KillMode=control-group` and short `TimeoutStopSec` are a service-level shutdown backstop: stopping the unit also stops detached Bubblewrap children. `CPUQuota`, `MemoryMax`, and `TasksMax` are editable **aggregate cgroup limits** for the trusted application and all of its Bubblewrap tool processes together. The unit starts Node normally; it does not use `systemd-run`.

The example intentionally does not set `ProtectSystem`, `PrivateNetwork`, or other systemd namespace restrictions. Bubblewrap owns the filesystem and namespace boundary for each tool, and its `--share-net` behavior is intentional.

Development: `pnpm run dev`. The service uses Telegram long polling. Private chats are the intended v1 usage. Data is still namespaced by numeric `chat.id`, while authorization always uses numeric `from.id`.

All non-command updates in a chat share one ingress buffer. Every update resets a two-second quiet timer; once quiet, ordered text, captions, attachments, and any download failures are submitted as one logical request. There is deliberately no `media_group_id` special case. Common Telegram file attachments are saved persistently under `workspace/attachments/YYYY-MM-DD/<message-id>/`, and Pi receives their sandbox-visible `/workspace/...` paths plus type, MIME type, and original-name metadata. Telegram's Bot API download ceiling of 20 MB per file applies. Unsupported non-file messages are described textually rather than silently discarded.

If another assembled request arrives while Pi is running, it is passed through Pi's native steering mechanism as one message; the already-active run sends the eventual response, avoiding a reply per quick update. `/start` bypasses buffering. `/new` first flushes that chat's current buffer, waits behind the active run, then disposes the active Pi session and starts a new JSONL file. Older files remain in the workspace and are searchable by Pi tools.
Outbound file delivery and scheduling use workspace protocols: workspace outbox requests are delivered by trusted service logic, and `.tg-bot/schedules.json` is handled by the filesystem-only scheduler. Due reminders run as Pi worker follow-ups and survive restarts. There is no custom `send_file`/`web_search` tool layer; network requests follow native Pi worker behavior inside Bubblewrap.

## Configuration

Required:

- `TG_BOT_TOKEN`: Telegram bot token.
- `ALLOWED_USER_IDS`: comma-separated positive numeric Telegram user IDs. Missing, empty, zero, or malformed values fail startup; there is no allow-all mode.
- `DATA_DIR`: persistent host data root.

Pi provider credentials and model selection are workspace-owned. Before the first prompt for a chat, place the Pi files required by the selected provider under `DATA_DIR/chats/<numeric-chat-id>/workspace/.pi/agent/` (typically `auth.json`, `models.json`, and `settings.json`). The worker passes no host environment through Bubblewrap, so provider secrets are never inherited from the service process. The old shared `.pi-runtime` layout is not migrated.

Pi's `settings.json` accepts `defaultProvider`, a provider-local `defaultModel`, and `defaultThinkingLevel`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. `/new` starts a fresh JSONL session while retaining prior session files in the same workspace.

The worker uses the exact chat workspace as its persistent Pi resource/config root. It discovers scanned workspace skills from `.pi/skills/` and `.agents/skills/`; Pi extensions and native tools execute inside the same Bubblewrap worker boundary. Attachments are ordinary workspace files and are supplied to Pi as `/workspace/...` paths with metadata.

## Persistent layout

```text
DATA_DIR/chats/<numeric-chat-id>/
  workspace/                         # only persistent writable sandbox bind
    .pi/agent/                       # Pi auth, models, and settings
    .pi/sessions/*.jsonl              # canonical Pi conversation files
    .tg-bot/schedules.json            # workspace-owned reminders
    .tg-bot/outbox/{*.json,processed,failed}/
    attachments/YYYY-MM-DD/<message-id>/
    memory/                           # optional user-curated notes
    .cache/npm/ .cache/uv/ .local/ .python/
```

Normal files, workspace-local npm installs, uv environments/tools, scripts, caches, attachments, schedules, outbox requests, and Pi sessions persist. Pi JSONL remains the authoritative transcript; memory and history files are data, not higher-priority instructions. The application maintains no second transcript or memory database.

The sandboxed `read` tool supports Pi-compatible text pagination (`offset` is 1-indexed and `limit` is a line count) plus inline images detected from file signatures: JPEG, static PNG, GIF, WebP, and BMP. Image bytes are captured through Bubblewrap as binary data, resized to Pi's 2000×2000 / inline-size constraints, and returned as model image content; model-provided paths are never read with host filesystem APIs. Image capture is bounded at 20 MiB. Animated PNG and JPEG XL are intentionally treated as ordinary/non-image files, matching Pi's built-in signature rules.

## Sandbox boundary

Each tool call directly uses Node `spawn("bwrap", argv, { env: {}, detached: true })`; model commands are never interpolated into a host shell. Only the inner sandbox `bash` tool receives `/bin/bash -lc <exact command>` as distinct arguments.

- read-only: `/usr`; `/bin`, `/lib`, and `/lib64` when present; the installed `node_modules` tree at `/app/node_modules`
- read-only, individually when present: `/etc/resolv.conf`, `/etc/hosts`, `/etc/ssl`, `/etc/pki`, `/etc/ca-certificates`
- private/synthetic: `/proc`, `/dev`, and tmpfs `/tmp`
- read/write: the assigned chat workspace at `/workspace`
- no host home, service source, data root, or shared session mount

It does **not** bind host `/`, `/home`, `/root`, `/run`, service source, SSH/Docker sockets, or unrelated data directories. It unshares user, PID, IPC, and UTS namespaces, drops all capabilities, uses a new session, and intentionally shares the network. The threat boundary is filesystem containment enforced by Bubblewrap/kernel, not defense against kernel exploits or hostile local-network services. The agent can exfiltrate anything it can read, destroy its workspace, and run arbitrary downloaded package code inside this boundary.

Sandbox environment (and nothing inherited):

```text
HOME=/workspace
TMPDIR=/tmp
PATH=/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin
NPM_CONFIG_CACHE=/workspace/.cache/npm
NPM_CONFIG_PREFIX=/workspace/.local
UV_CACHE_DIR=/workspace/.cache/uv
UV_TOOL_BIN_DIR=/workspace/.local/bin
UV_TOOL_DIR=/workspace/.local/share/uv/tools
UV_PYTHON_INSTALL_DIR=/workspace/.python
```

Tool output is bounded by the application, and timeout kills the detached Bubblewrap process group. Startup fails rather than falling back to unsandboxed execution if the data root is not writable, Bubblewrap is unavailable, or the sandbox cannot run the required runtime commands.

## Tests

```sh
pnpm run typecheck
pnpm test
RUN_BWRAP_TESTS=1 pnpm test
# or only the Linux integration suite:
pnpm run test:integration
```

Unit tests cover fail-closed configuration, canonical paths, response splitting, serialization, response extraction, exact tool argv/stdin handling, attachment buffering and metadata, confined file delivery, resource symlink rejection, outbox recovery, scheduler persistence/recurrence/shutdown, Pi RPC lifecycle, and Bubblewrap argument construction. Opt-in Linux integration covers persistence, resource isolation, secret-free environment, bounded output, and process timeout.

For deployment, separately smoke-test provider authentication using workspace-owned Pi files, Pi restart/continue and `/new`, Telegram authorization and ordering, attachment downloads, outbox delivery, schedule recurrence, network access, npm/uv package persistence, all required runtime commands, and an unmounted host canary on the exact target distribution.
