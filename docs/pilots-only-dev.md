# Native Codex Pilot experiment

> Historical experiment, superseded by #993. The native runtime and permission
> behavior below are no longer shipped. For current development and authority,
> use [provider runtimes](pilot-providers.md), [project workers](project-workers.md),
> and the [verification guide](../.claude/skills/verify/SKILL.md).

Codex-backed Pilots use a persistent native Codex app-server thread. Shell,
patching, web tools, execution lifetimes, and escalation belong to that thread.
BigBrain adds graph/memory tools, notifications, conversation storage, and UI.
It no longer replaces Codex's base instructions or disables its native tools.
New worker delegation is disabled in both the installed desktop and this dev
path. Pilot is the single conversation type for new work.

On startup and session refresh, settled legacy work sessions migrate once into
durable Pilots. Their messages, timestamps, context, submitted outputs, and
provider/thread identity are preserved. The original worker files (including
activity, receipts, and historical permission requests) remain on disk. Graph
and search results coalesce their old source records into the Pilot; existing
worker links open the Pilot conversation. Future messages use the configured
Pilot backend in a fresh runtime, with current vault permissions. Migration
does not launch a model, replay work, inherit grants, or ingest history again.
Sessions still running or owned by an external terminal wait until they settle
and return to app ownership. Migrated workers cannot resume through the old
worker runtime.

Gardener and memory passes keep their existing headless curation adapter and
restricted tools. The Responses backend keeps its separate local-command runner.

Start the dev UI with isolated Pilot session storage:

```sh
BIGBRAIN_VAULT=/absolute/path/to/dev-vault \
BIGBRAIN_PILOT_CONTEXT_ROOT=/absolute/path/to/displayed-vault bun run pilot:dev
```

UI: http://127.0.0.1:5221; backend: 5220. Override with
`BIGBRAIN_PILOT_UI_PORT` and `BIGBRAIN_PILOT_DEV_PORT`. Other graph APIs proxy
to the installed backend on 4747; this is not an isolated copy of every vault
API. `BIGBRAIN_PILOT_CONTEXT_ROOT` must match the vault served by that backend: graph resolution, mention validation, memory, and reader tools use it. Session storage and vault mutation tools remain rooted in the dev vault. Don't run two session owners against one vault. The installed running
backend must be restarted/rebuilt separately to pick up source changes.

Vault Settings folders and control-directory exclusions define every native
Pilot's permission profile. The stored grants are only a cached execution profile;
legacy per-session grants, revocations, and unrestricted modes are replaced by
the vault settings. Settings changes pause affected warm sessions before their
profiles change. Native on-request approval is enabled;
this does not silently give every Pilot unrestricted access. Native command,
file-change, permission, and question callbacks appear in the conversation and
Pilots attention pane. Approvals are correlated to one request; the UI offers
one-time acceptance or decline, and additional permission grants last one turn.
File approvals include the proposed changes. Stop, disconnect, and restart
invalidate pending callbacks. Native automatic approval review, when configured
in Codex, still runs before requests reach the UI.

Codex retains its normal installed configuration, native tools, and model
instructions. BigBrain supplies additive developer instructions. This aligns
execution with Codex, but does not promise identical outputs or permissions to
an arbitrary terminal session. Project access remains explicit. Native threads
from the old tool contract are replaced without replaying completed actions;
application history and previous thread IDs are retained.

Validation includes native patch/shell execution and network recovery through
native escalation, request correlation, decline, interruption, restart, provider
switching, and the real UI's approval controls. The hiring prompt is left as an
unsent Astra draft for manual comparison.
