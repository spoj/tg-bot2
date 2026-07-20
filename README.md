# tg-bot2

A small personal Telegram text agent. The trusted TypeScript process owns Telegram/model credentials and Pi JSONL sessions. Every model-facing `read`, `write`, `grep`, and `bash` call starts the same Bubblewrap filesystem sandbox.

## Requirements

- Linux with Bubblewrap (`bwrap`) and user namespaces enabled
- Node.js 22.19 or later and npm
- Host executables available below `/usr` or `/bin`: `bash`, Node/npm, Python, `uv`, Git, curl, `rg`, and `jq`
- CA certificates under `/etc/ssl`, `/etc/pki`, or `/etc/ca-certificates`
- A Telegram bot token and a Pi-supported model API key

Example Debian/Ubuntu packages (package names vary by distribution):

```sh
sudo apt install bubblewrap nodejs npm python3 git curl ripgrep jq ca-certificates
# Install uv system-wide so it is available under /usr or /bin.
```

## Setup and run

```sh
npm install
cp .env.example .env
# Edit .env, then load it into the service environment:
set -a; . ./.env; set +a
npm run build
npm start
```

Development: `npm run dev`. The service uses Telegram long polling. Private chats are the intended v1 usage. Data is still namespaced by numeric `chat.id`, while authorization always uses numeric `from.id`.

`/new` is serialized behind pending turns for that chat, then disposes the active Pi session and starts a new JSONL file. Older files are retained and visible read-only to tools.

## Configuration

Required:

- `TG_BOT_TOKEN`: Telegram bot token.
- `ALLOWED_USER_IDS`: comma-separated positive numeric Telegram user IDs. Missing, empty, zero, or malformed values fail startup; there is no allow-all mode.
- `DATA_DIR`: persistent host data root.
- At least one model credential supported by Pi, for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`.

Optional:

- `AGENT_MODEL`: Pi `provider/model` selector. Without it Pi restores the session model, uses configured defaults, or selects an authenticated model.
- `AGENT_THINKING`: `off`, `minimal`, `low`, `medium` (default), `high`, `xhigh`, or `max`.
- `TOOL_TIMEOUT_MS`: default `120000`.
- `MAX_TOOL_OUTPUT_BYTES`: per-stream capture limit, default `50000`.

The harness uses an isolated Pi resource/config directory below `DATA_DIR/.pi-runtime`. It automatically loads the exact chat workspace's `AGENTS.md` and discovers workspace skills from `.pi/skills/` and `.agents/skills/`, matching normal Pi project conventions. Prompt templates and themes are disabled because Telegram does not expose their normal UI. Workspace extensions remain disabled: Pi extensions execute as trusted host-process code and would bypass Bubblewrap, so downloaded workspace code must instead run through the sandboxed `bash` tool. Provider credentials remain in the host process and are resolved by Pi's `ModelRuntime` from environment variables. They are never copied to the sandbox.

## Persistent layout

```text
DATA_DIR/chats/<numeric-chat-id>/
  workspace/             # only persistent writable sandbox bind
    sessions_ro/         # empty host mount point, shadowed in bwrap
    .cache/npm/ .cache/uv/ .local/ .python/
  sessions/              # canonical Pi-owned JSONL session files
```

Normal files, workspace-local npm installs, uv environments/tools, scripts, and caches persist. Pi owns conversation context; the application maintains no second transcript or memory database.

## Sandbox boundary

Each tool call directly uses Node `spawn("bwrap", argv, { env: {}, detached: true })`; model commands are never interpolated into a host shell. Only the inner sandbox `bash` tool receives `/bin/bash -lc <exact command>` as distinct arguments.

Mounts:

- read-only: `/usr`; `/bin`, `/lib`, and `/lib64` when present
- read-only, individually when present: `/etc/resolv.conf`, `/etc/hosts`, `/etc/ssl`, `/etc/pki`, `/etc/ca-certificates`
- private/synthetic: `/proc`, `/dev`, and tmpfs `/tmp`
- read/write: the assigned chat workspace at `/workspace`
- read-only overlay: that chat's canonical session directory at `/workspace/sessions_ro`

It does **not** bind host `/`, `/home`, `/root`, `/run`, service source, SSH/Docker sockets, or the overall data root. It unshares user, PID, IPC, and UTS namespaces, drops all capabilities, uses a new session, and intentionally shares the network. The threat boundary is filesystem containment enforced by Bubblewrap/kernel, not defense against kernel exploits or hostile local-network services. The agent can exfiltrate anything it can read, destroy its workspace, and run arbitrary downloaded package code inside this boundary.

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

Timeout kills the detached Bubblewrap process group. Combined stdout/stderr capture is bounded by `MAX_TOOL_OUTPUT_BYTES`, and tool output explicitly reports timeout/truncation. Startup fails rather than falling back to unsandboxed execution if the data root is not writable, Bubblewrap is unavailable, or the sandbox cannot run `node`, `uv`, and `rg`.

## Tests

```sh
npm run typecheck
npm test
RUN_BWRAP_TESTS=1 npm test
# or only the Linux integration suite:
npm run test:integration
```

Unit tests cover fail-closed configuration, canonical paths, response splitting, serialization, response extraction, exact tool argv/stdin handling, grep semantics, timeout/truncation rendering, and Bubblewrap argument construction. Opt-in Linux integration covers persistence, read-only sessions/system paths, secret-free environment, bounded output, and process timeout.

For deployment, separately smoke-test provider authentication, Pi restart/continue and `/new`, Telegram authorization and ordering, network access, npm/uv package persistence, all required runtime commands, and an unmounted host canary on the exact target distribution.
