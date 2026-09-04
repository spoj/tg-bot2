# tg-bot2 Pi package scope review

This plan does not change `~/.pi/agent/`.

## Scope choices

Replace each `TODO` with exactly one choice:

- `HARNESS` — pin in tg-bot2 and provide read-only to every bot workspace.
- `WORKSPACE` — do not provide from tg-bot2; Save Matthew may keep/install it in its own `.pi/agent/settings.json`.
- `REMOVE` — do not provide it and remove it from Save Matthew's settings if present.

## Package decisions

| Package | Current scope | What it does | Suggested | Decision |
|---|---|---|---|---|
| `npm:pi-agent-browser` | personal only | Browser automation tool and screenshots | `HARNESS` | `HARNESS` |
| `npm:pi-exa` | personal + Save Matthew | Exa web search and fetch tools | `HARNESS` | `HARNESS` |
| `git:github.com/spoj/pi-tiny-fork` | personal + Save Matthew | Asynchronous Pi session forks | `HARNESS` | `HARNESS` |
| `git:github.com/spoj/pi-tiny-tools` | personal only | Compact TUI rendering for tools/messages | `REMOVE` (RPC bot has no interactive TUI) | `REMOVE` |
| `git:github.com/spoj/pi-show-herdr` | personal only | Interactive Herdr review tool | `REMOVE` (Herdr is not exposed inside bot sandbox) | `REMOVE` |
| `git:github.com/spoj/pi-tiny-monitor` | personal only | Background process monitor with bounded/rate-limited output | `HARNESS` | `HARNESS` |
| `git:github.com/spoj/pi-tiny-ask` | personal only | Media inspection and image generation through another model | `HARNESS` if its extra capabilities are wanted; tg-bot2 already provides `multimodal.ts` | `HARNESS`; remove the existing multimodal extension |
| `npm:@gregjohnso/pi-monitor` | Save Matthew only | Older background process monitor | `REMOVE` if `pi-tiny-monitor` is selected | `REMOVE` |

## Pi runtime version

The tg-bot2 runtime is pinned by this repository, independently of personal Pi:

- Current: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `0.84.2`
- Latest published when this review was created: `0.85.0`
- Workers run this repo's `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`

Replace `TODO`:

update to latest as of now

## Phase 1: tg-bot2 harness

After approval:

1. Update the pinned Pi packages in `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` if requested.
2. Add each `HARNESS` package as an exact/pinned tg-bot2 dependency.
3. Pass those packages to every Pi RPC worker as harness-owned extensions.
4. Keep the harness copies read-only inside the sandbox.
5. Add tests proving the selected extensions are exposed and workspace settings are not required.
6. Run typecheck, tests, and integration checks.

## Phase 2: Save Matthew workspace cleanup

Only after Phase 1 is working:

1. Remove harness-provided packages from Save Matthew's `.pi/agent/settings.json`.
2. Keep packages marked `WORKSPACE` there.
3. Remove packages marked `REMOVE`.
4. Preserve Save Matthew's model/auth and other non-package settings unless separately approved.
5. Restart tg-bot2 and smoke-test the tools.

## Optional non-package alignment (Phase 2)

These do not need a decision for package migration. Mark `KEEP`, `CHANGE`, or add a note.

| Save Matthew setting | Current value | Decision / desired value |
|---|---|---|
| Default model | `github-copilot/gpt-5.6-luna` | `KEEP` |
| Default thinking | `xhigh` | `KEEP` |
| Fork model | `github-copilot/gpt-5.6-luna` | `KEEP` |
| Fork thinking | `xhigh` | `KEEP` |
| `steeringMode` | `all` | `KEEP` |
| `followUpMode` | `all` | `KEEP` |
| Theme | `dark` | `KEEP` |

this section okay
