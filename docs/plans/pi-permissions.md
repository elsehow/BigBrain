> Implemented by #1000–#1002. See [project workers](../project-workers.md) and [model roles](../pilot-providers.md) for the shipped behavior.

# Pi execution and permissions throughout BigBrain

Proposal for #993, following #989 and #992. Audited against fetched main
`bedf326f` on 2026-09-26; Pi onboarding remains in PR #992. This document
proposes product behavior and implementation boundaries; it does not claim
that worker sandboxing or the UI described here exists today.

The accompanying [runtime simplification audit](pi-runtime-simplification.md)
identifies further reductions enabled by these boundaries and Pi-only execution.

## Decision to make

Use Pi for every model session, with different capabilities for each job.
BigBrain owns the fixed capabilities of Quick, memory, Gardener, and Pilot.
Users choose connected accounts, remembering rules, and reference folders;
those choices cannot turn an app role into a general execution agent.
Orchestrated agents get an explicitly authorized workspace and task scope.
Changing model/provider never changes permissions.

A capability is what a role can do; a resource scope is where it can do it.
For example, Pilot can read an additional folder selected by the user, but
that selection cannot grant Pilot shell execution or project writes.
Existing remembered evidence remains readable when an account's live access
is disabled. Remembering rules and live access remain separate settings.

## Fixed app roles

| Job | Read access | Allowed effects | Excluded capabilities |
| --- | --- | --- | --- |
| Quick | Bounded evidence supplied by its caller | Return text/structured output; host validates and stores the result | No tools, filesystem discovery, live sources, shell, or delegation |
| Memory synthesis | Curated record, cited source evidence, existing memory | Create, replace, and prune memory Markdown through dedicated tools | No arbitrary file writes, live sources, curation submissions, shell, or delegation |
| Memory fold proposals and similar transformations | Supplied census/evidence only | Return proposals; host validates and persists them | No tools, even when using the memory model |
| Gardener | Landed arrivals, staged items and remembering rules, existing record; no synthesized memory | Admit/pass staged items; append validated assertions/declines and supported scoped skip rules | No direct memory/log editing, live-source operations, shell, or delegation |
| Pilot | Vault/memory, user-attached context, enabled live sources, selected reference folders, own scratch | Answer, manage conversation/context/notifications, write scratch, contribute via drop/directive, coordinate authorized workers, supported explicit user-requested source actions | No general shell, project writes, direct curation, permission grants, or arbitrary plugin execution |

These are separate application profiles, not user-editable permission presets.
Within a role, the caller selects the smallest profile its job needs. A fold
proposal does not inherit memory-writing authority from the model selection.
Host-managed journals, commits, checkpoints, and validated result publication
are host operations, not additional tools granted to the model.

No general network tool is supplied to these roles. Provider inference and
Pilot's account-scoped source calls still use the network through the host.
Application code, not a prompt or a hidden tool listing alone, enforces each
profile and validates arguments at the actual operation boundary.

### Changes identified in the audit

- Quick briefings already request `capabilities: "none"`; entity-fold proposals
  already request no tools. Preserve both as explicit profiles.
- Memory already has dedicated Markdown writers. Keep citation, size, and
  consistency validation. After all unrestricted execution paths are gone,
  assess replacing whole-vault violation sweeps with memory-scoped validation
  and recovery; never remove these guards before the boundary is proven.
- Gardener currently receives all `INTEGRATION_TOOLS`, including
  `inbox_set_unread` when account policy permits it. Proposed tightening:
  remove live-source tools altogether. Pollers supply staged content and
  Gardener curates that content; adding new evidence gathering should be an
  explicit product decision, not an accidental consequence of shared tools.
- Pilot currently exposes `inbox_set_unread`, while its instructions also say
  it cannot change external source state. Settle this consistently: retain
  the supported read/unread action for an explicit user request, with account
  checks; reading or summarizing alone never changes the flag. Do not add
  send/publish capabilities to Pilot as a side effect of this migration.
- `runSessionJob` partially derives tools from role strings, and `machineTools`
  defaults non-Gardener roles to reader tools. Use exhaustive profile selection
  and reject an unknown profile. No generic role-based privilege fallback.

## Orchestrated agents: the user-facing contract

User-selected default: authorize a project once.
Future user-requested tasks can use that project's saved scope without
repeated approval of ordinary edits or tests. New projects start with no
execution grant. An unassigned task can use private scratch; it does not gain
access to arbitrary directories merely because Pilot supplies a `cwd`.

Replace provider-specific runner settings with a project/workspace list under
Agent Orchestration. Each entry has a folder and two understandable modes:

- **Read and propose:** inspect permitted files, return an answer or proposed
  changes, and write task scratch. No shell or edits to the selected project.
- **Work in this project:** edit project files and run commands inside the
  enforced workspace boundary, including builds and tests. Local deletion and
  executing project scripts are part of this authority, not just text editing.

A user chooses a model separately through the existing provider connections.
Project authorization does not grant general access to the home directory,
BigBrain credentials, the live vault filesystem, sibling projects, or other
workers' scratch. Additional reference folders can be read-only. Protect the
vault even if it is selected as a worker project; contributions go through the
existing vault tools instead of bypassing the record's validators.

Keep the remaining controls small and show them as project details:

| Control | Default | How it expands |
| --- | --- | --- |
| Workspace | Private task scratch, or a user-selected project | User adds/changes the folder and mode |
| Network for commands | Off | Request named destinations; allow for this task or explicitly remember for this project |
| BigBrain context | A bounded handoff containing relevant evidence | Request more through Pilot or scoped host reader tools; no automatic full-conversation, memory, or account inheritance |
| Live sources | None for the worker | Select accounts for this task/project, limited by current account policy and the worker's supported operations |

Model-provider traffic is independent of command-network access. A domain
grant allows communication with that destination; it cannot honestly be
labelled read-only internet access or a guarantee against uploading data.
Authenticated service actions should use scoped host tools that keep secrets
out of the command environment. Such tools can enforce an approved operation;
raw shell access to the same service cannot offer that semantic guarantee.

For Git projects, prefer a separate worktree and show changes for review before
applying them to the user's checkout. Keep worktree choice separate from the
permission mode: it prevents edit collisions, not unauthorized access. For
non-Git folders, show that changes are direct; do not promise rollback or
build a general snapshot/merge system in the first version. Remote publishing
or merging is not implied by creating local changes.

### An ordinary interaction

The user asks Pilot to fix a problem in an authorized project. Pilot starts a
worker and supplies relevant evidence. Its task card says which project it can
change and whether networking is available. The worker edits files and runs
local tests without repeated prompts. If it needs a package host, the card
requests access to that named destination and offers **Allow for this task**,
**Remember for this project**, and **Decline**. A missing source account or
additional folder uses the same pattern, with the exact access stated.

Ordinary clarification goes to Pilot. Only the user's trusted UI action can
create or enlarge an access grant; `ask_pilot`, a tool argument, source text,
project instructions, and agent replies cannot. Pilot can use a user's
established project grant for an authorized task, but cannot fabricate a new
one. An automatic worker report does not authorize unrelated follow-on work.
Task authorization still matters inside a standing resource grant.

Pending approvals stay pending while the user is absent. A tool call, task
result, or elapsed time cannot approve them. Bind an approval to the exact
request and task; an edited request needs a new decision. Do not prompt for
a scope already approved. Source actions such as sending/publishing, if later
supported, must honor the concrete user authorization without making the user
approve the same action twice.

## Enforcement and reuse

Use one BigBrain run policy and operation dispatch boundary, with named fixed
app profiles and a parameterized worker profile. Avoid a new configurable
policy language. The effective worker scope is its launch grant intersected
with current project/account permissions and the fixed worker ceiling.
Settings can revoke access immediately; a later expansion does not silently
broaden an already running task. Record the effective policy with the work
record and retain actor/task attribution on effects.

For the fixed roles, continue using BigBrain's domain tools through Pi's SDK.
For workers, reuse Pi's read/edit/write/search/Bash implementations. Its pinned
0.85.1 tool factories expose replaceable operations, so bounded filesystem and
command execution can sit underneath them without rebuilding those tools.
The enforcement must cover every file/search path and command descendant,
including traversal, symlinks, environment variables, sockets, and access to
other local services. A `cwd` and a Bash command parser alone are insufficient.

A promising implementation to spike is host-owned Pi/model sessions with a
separate execution process per worker. The host owns subscription credentials,
source adapters, policy, and receipts; the execution process receives only
required inputs and a sanitized environment. Reuse an existing sandbox runtime
and Pi tool operations for that boundary. An ordinary child process is not
itself a sandbox. Restart the executor when filesystem grants change if the
chosen sandbox cannot update them safely. Block execution on sandbox startup
failure; never retry unsandboxed automatically.

Before selecting a delegation extension, compare its lifecycle against the
existing `AgentOrchestrator`: launch, questions, progress, follow-up, stop,
history, and restart. Choose one lifecycle owner. A plugin is useful if it
replaces code we would otherwise maintain; do not run a second orchestration
system beside ours. Nested children must inherit an equal or narrower scope,
share the parent's cancellation and resource limits, and never discover fresh
credentials, tools, or projects implicitly. Nested delegation can stay off
until this inheritance is implemented.

Bundle and pin selected extensions as trusted application dependencies. Do not
auto-load a user's global Pi extensions or executable code from a project.
Project instruction files can guide a worker within its existing scope; they
cannot modify grants. No permission bypass mode or plugin marketplace is
needed for the first version. Platform-specific containment must be validated
before advertising the corresponding mode; unsupported execution is an
explicit unavailable capability, not weaker behavior under the same label.

Revoking a grant stops affected execution and blocks subsequent source/file
calls. Revocation cannot erase evidence already delivered to a model or undo
completed external effects. On restart, preserve history and pending work;
mark uncertain operations and revalidate grants before continuing. Do not replay
an uncertain write merely to reconstruct the conversation.

## Sequence and meaningful checks

1. Review this role matrix and the project-authorization interaction. The user
   selected authorization once per project; the remaining details are proposed.
   Keep #989's backend retirement separate from the broader worker migration.
2. Make role selection exhaustive and remove Gardener's live tools. Test real
   denied operations, including calling a hidden tool directly and misleading
   role/model combinations. Retain Quick/fold zero-tool behavior and memory
   citation/output guarantees.
3. Spike one Pi worker in a disposable project with file edits, a real command,
   two simultaneous workers, a denied read/write/network operation, app-based
   access expansion, and descendant cancellation. Include actual SDK/Bun and
   desktop packaging; do not infer parity from extension README claims.
4. Add the project settings, readable task scope, and inline access requests to
   the production AppShell. Test reload, stale approvals, grant revocation,
   changes during execution, and restart without replay.
5. Migrate native workers and remove provider-specific permissions, native
   settings inheritance, CLI discovery, terminal handoff, duplicate fixtures,
   and obsolete dependencies as described in #993. Retain external MCP/client
   authorization as an independent boundary.

Sources: [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md),
[Pi tool factories](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools),
[permission extension limits](https://github.com/wynainfo/pi-permission-modes/blob/main/SECURITY.md),
[sandbox-runtime](https://github.com/anthropics/sandbox-runtime), and the
[extension comparison in #993](https://github.com/elsehow/BigBrain/issues/993).
The permission extension's defaults allow broad reads, although current
sandbox-runtime supports narrower read configurations. Verify pinned versions
and all platform paths; neither default extension settings nor a worktree alone
establish the proposed workspace boundary.
