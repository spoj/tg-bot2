# tg-bot2 Pi package scope

This migration does not change `~/.pi/agent/`.

## Final package decisions

| Package | Scope |
|---|---|
| `npm:pi-agent-browser` | Shared harness |
| `npm:pi-exa` | Shared harness |
| `git:github.com/spoj/pi-tiny-fork` | Shared harness |
| `git:github.com/spoj/pi-tiny-monitor` | Shared harness |
| `git:github.com/spoj/pi-tiny-ask` | Shared harness |
| `git:github.com/spoj/pi-tiny-tools` | Not added |
| `git:github.com/spoj/pi-show-herdr` | Not added |
| `npm:@gregjohnso/pi-monitor` | Removed from Save Matthew |

Recommended packages are declared in the repository's `agent/settings.json`,
not in `package.json`. Deployment uses these defaults to provision each
workspace-owned Pi profile before workers start.

## Pi runtime

The tg-bot2 repository pins Pi `0.85.0` independently of personal Pi:

- `@earendil-works/pi-ai`: `0.85.0`
- `@earendil-works/pi-coding-agent`: `0.85.0`
- `@earendil-works/pi-server`: `0.85.0`

## Native Pi scope layout

Each bot owns a writable Pi profile at
`$DATA_DIR/workspaces/<workspaceId>/workspace/.pi/agent/`, exposed inside its
workers at `/workspace/.pi/agent/`. Deployment initialization must create its
`npm/` and `git/` stores, provision `settings.json`, `AGENTS.md`, and credentials,
and materialize the recommended packages before workers start. The repository's
`agent/` files are defaults for that explicit per-workspace provisioning step.
After provisioning, the bot may update its own model catalog and packages without
affecting another workspace.

Service-enforced host tools do not live in the writable profile. The host mounts
`extensions/host-tools.ts` read-only under `/app/extensions/`, loads it with an
explicit `--extension` argument, and limits it with authenticated host capabilities.

Each bot workspace uses these native Pi scopes:

```text
/workspace/.pi/agent/          # writable user profile, catalog, and recommended packages
/workspace/.pi/settings.json   # project settings
/workspace/.pi/npm/            # project packages
/workspace/.pi/git/            # project packages
/workspace/.pi/sessions/
```

Project settings can add packages with `pi install -l <source>`. Pi combines
`/workspace/.pi/agent/settings.json` with `/workspace/.pi/settings.json`; project
entries win for duplicate package identities.

## Prompt and settings migration

Recommended bot instructions live in `agent/AGENTS.md` and are copied into each
workspace profile during provisioning. Only dynamic connector instructions and
the per-conversation notification path are appended at worker startup. Model,
thinking, steering, and follow-up settings are read by Pi from native settings
rather than by tg-bot2.

Save Matthew's preferences are now in:

```text
$DATA_DIR/workspaces/8442941973/workspace/.pi/settings.json
```

Save Matthew's Pi profile, including its credentials and model catalog, lives at:

```text
$DATA_DIR/workspaces/8442941973/workspace/.pi/agent/
```
