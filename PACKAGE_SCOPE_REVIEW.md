# tg-bot2 Pi package scope

This migration does not change `~/.pi/agent/`.

## Final package decisions

| Package | Scope |
|---|---|
| `npm:pi-agent-browser@0.1.0` | Shared harness |
| `npm:pi-exa@0.6.1` | Shared harness |
| `git:github.com/spoj/pi-tiny-fork@5c7c3647f4b2f87a3e39fba4b4f20edc7afaa185` | Shared harness |
| `git:github.com/spoj/pi-tiny-monitor@ab7fa33eab6af9530f084c19acb286447076737e` | Shared harness |
| `git:github.com/spoj/pi-tiny-ask@487144ddde9179dca6767f77558e55c1f59cd05f` | Shared harness |
| `git:github.com/spoj/pi-tiny-tools` | Not added |
| `git:github.com/spoj/pi-show-herdr` | Not added |
| `npm:@gregjohnso/pi-monitor` | Removed from Save Matthew |

Deployment-default harness packages are declared in the repository's
`agent/settings.json`, not in `package.json`. Deployment provisions them into
Pi's native global package scope before workers start.

## Pi runtime

The tg-bot2 repository pins Pi `0.85.0` independently of personal Pi:

- `@earendil-works/pi-ai`: `0.85.0`
- `@earendil-works/pi-coding-agent`: `0.85.0`
- `@earendil-works/pi-server`: `0.85.0`

## Native Pi scope layout

The deployment-owned Pi profile is `$DATA_DIR/agent/`, mounted entirely
read-only into every worker as `/app/agent`. Deployment initialization must create
its `npm/` and `git/` stores, provision `settings.json` and `AGENTS.md`, and
materialize every configured package before workers start. The repository's
`agent/` files are defaults for that explicit provisioning step; runtime code does
not seed, install, or update profile resources. Package caches and the shared
`auth.json` remain in `$DATA_DIR/agent/`; package updates are explicit host
maintenance (`PI_CODING_AGENT_DIR="$DATA_DIR/agent" ./node_modules/.bin/pi update --extensions`) followed by a worker restart.

Each bot workspace uses native project scope:

```text
/workspace/.pi/settings.json
/workspace/.pi/npm/
/workspace/.pi/git/
/workspace/.pi/sessions/
```

Project settings can add packages with `pi install -l <source>`. Pi combines
`/app/agent/settings.json` with `/workspace/.pi/settings.json`; project entries
win for duplicate package identities.

## Prompt and settings migration

Static harness instructions live in `agent/AGENTS.md`. Only dynamic connector
instructions and the per-conversation notification path are appended at worker
startup. Model, thinking, steering, and follow-up settings are read by Pi from
native settings rather than by tg-bot2.

Save Matthew's preferences are now in:

```text
$DATA_DIR/workspaces/8442941973/workspace/.pi/settings.json
```

The obsolete `$DATA_DIR/workspaces/8442941973/workspace/.pi/agent/` directory
was removed. The existing Save Matthew `auth.json` was moved to the shared
`$DATA_DIR/agent/auth.json` profile as agreed.
