# Archived plan: Minimal Persistent Telegram Agent

> **Status: archival only.** This file records the security rationale and early design decisions that preceded the shipped runtime. It is not an implementation plan, specification, or acceptance checklist. The current contract is [`README.md`](README.md); when this file differs from README, README wins.

## What the original plan was trying to protect

The project began as a small personal Telegram agent with a trusted TypeScript process on the host and a per-chat persistent workspace behind Bubblewrap. The useful architectural ideas were:

- Telegram credentials and orchestration remain in the trusted process.
- Each chat gets a workspace whose normal files survive restarts.
- Model-controlled commands execute inside a fresh Bubblewrap process rather than a host shell.
- The sandbox exposes only deliberately selected system paths, a private temporary filesystem, and the assigned workspace; it does not mount the host root, home directory, service source, sockets, or unrelated data.
- The sandbox receives an explicitly constructed environment, not the service environment. Provider and Telegram secrets therefore do not cross the boundary.
- Network access is intentionally available inside the sandbox for ordinary workspace work, while the threat boundary remains filesystem containment rather than protection from kernel exploits or hostile local-network services.

These principles remain useful historical rationale, but the concrete mounts, lifecycle, tools, and configuration are maintained in README and the source code.

## Historical product context

The original proposal targeted a single-user Telegram service with authorized numeric user IDs, durable per-chat state, resumable Pi conversation history, ordinary Linux commands, and a small auditable trusted surface. It deliberately avoided a second memory database and treated Pi's JSONL conversation files as the authoritative transcript.

The proposal also accepted that an agent could exfiltrate or destroy anything visible in its workspace, and that downloaded packages or scripts could execute arbitrary code inside the sandbox. Those trade-offs explain why the original design emphasized selective mounts, clean environment construction, direct process arguments, output limits, timeouts, and fail-closed startup rather than trying to make arbitrary workspace code trustworthy.

## Decisions superseded by the shipped runtime

The following passages from the original plan are retained only as historical references. They are **not** instructions for current or future implementation:

| Archived proposal | Current source of truth |
| --- | --- |
| A host-side Pi SDK `AgentSession` loop owned session creation, prompting, and response extraction. | The maintained path is Telegram ingress → `AgentManager` → `PiRpcWorker` → Bubblewrap. See README and the worker implementation. |
| Canonical sessions lived outside the workspace and were mounted read-only as `/workspace/sessions_ro`. | Pi worker JSONL sessions and provider configuration are workspace-owned under the layout documented in README. |
| Pi built-in tools were disabled and exactly four custom tools (`read`, `write`, `grep`, and `bash`) were registered. | Current Pi-native/worker tools and workspace protocols are the maintained tool contract; the retired custom-tool layer is not a design target. |
| npm was the preferred harness package manager unless the repository chose another convention. | pnpm is the repository's supported package manager; use README for setup commands. |
| Attachments, scheduling, and wakeups were listed as v1 non-goals. | Telegram attachment buffering, filesystem schedules, and the filesystem outbox are shipped behavior documented by README. |

Do not restore these archived structures, names, or acceptance claims merely because they appear in older sections of this document.

## Security rationale retained from the foundation work

The original plan's security review focused on a few durable invariants:

- authorization must fail closed when required configuration is missing, empty, or malformed;
- model-controlled paths must not become host paths through string interpolation or an unconfined host API;
- Bubblewrap arguments should be assembled as an argument array and launched directly;
- the assigned workspace is the only persistent writable host bind;
- runtime mounts should be selective and read-only where possible;
- output capture must be bounded and timed-out process trees must be terminated;
- the service must fail rather than silently execute unsandboxed when Bubblewrap or required runtime prerequisites are unavailable.

These are rationale, not a substitute for reading the current implementation. In particular, worker termination and lifecycle ownership now follow the maintained `sandbox.ts` and `PiRpcWorker` boundaries rather than the early host-side loop sketched here.

## Historical validation intent

The old plan called for unit coverage of configuration, path derivation, response handling, serialization, tool argument construction, and sandbox results, plus Linux checks for persistence, isolation, secret absence, output bounds, network access, and process timeouts. It also described manual Telegram and provider smoke checks.

Those lists are archived context only; they do not describe the present test suite or deployment procedure. Use README for current automated-test commands and for the separately labeled manual deployment smoke checks.

## Closing note

The original plan was valuable because it made the filesystem threat model and trusted/untrusted process split explicit. Its implementation sketches are obsolete. For setup, configuration, persistent layout, Pi behavior, attachment handling, outbox/scheduler operation, tests, and deployment, start with [`README.md`](README.md) and then the maintained source.