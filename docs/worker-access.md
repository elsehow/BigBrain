# Worker access

BigBrain owns permission decisions. Codex and Claude receive the same effective
filesystem grants, public-host network configuration, and explicit vault tools.
Their native approval callbacks cannot expand those grants.

## Authorization and grants

Settings → Vault → Agent access stores version 2 authorizations in
`BIGBRAIN_PILOT_AGENT_PERMISSIONS`:

```json
{"version":2,"folders":[{"path":"/Users/demo/Projects","access":"write"}]}
```

`write` includes read. Settings authorizations allow BigBrain to grant access
without another approval; they are not automatically mounted into every worker.
`list_work` offers authorized roots and their immediate project subdirectories.
Pilot selects the specific project, or supplies its `cwd`, and requests `read`
for inspection or `write` for edits. Folder authorizations are additive.

Every session has private scratch space. Research starts with only scratch.
Project work adds the selected project. Both providers start read-only project
work in scratch, because Claude implicitly permits writes in its working
directory. The project remains available at its granted absolute path.

Session access is persisted with the existing work record: grants, source of
approval, revision, applied revision, durable requests, revocations, and history.
The UI distinguishes requested/paused access from a policy applied by the adapter.
The existing vault MCP connection separately exposes memory, search, source reads,
and evidence submission. It does not expose curator tools. Other inherited
integrations and hooks stay disabled even in unrestricted managed sessions.

## Access requests

Both providers expose `request_access({path, access, reason})`; Claude presents
this as `mcp__bigbrain_access__request_access`. Only existing folders are supported.
The controller canonicalizes the target and rejects direct grants to protected
BigBrain control directories. Runtime policies also exclude control files under
broader grants.

1. Already granted (including scratch): return `granted`.
2. Covered by Settings: record an approved request and apply automatically.
3. Outside authorization or asking for more access: persist a pending request,
   pause the worker, and show the access card in its conversation.
4. Allow grants access for this session; the optional future-access checkbox also
   saves Settings authorization. Decline resumes with the previous grants and an
   explicit refusal. Duplicate/stale decisions are rejected.

The tool acknowledges a queued request immediately. It does not hold a native
callback open across a user interaction or a provider restart. BigBrain waits
for the old turn to stop, unsubscribes and closes that session's connection,
rebuilds its policy, and resumes the same provider conversation with the outcome.
Workers are instructed to inspect existing state before retrying interrupted
work. Each session has its own transport; other workers keep running.

Pending requests survive application restarts. Restart never automatically runs
a model. A recorded approval interrupted before application can be applied on a
user-triggered resume. Failed policy application leaves access inactive and the
session interrupted with an error, so it can be reviewed and retried.

## Changes and migration

Adding authorization does not widen running sessions. A pending request newly
covered by that authorization can proceed automatically. Narrowing/removing an
authorization pauses only workers with dependent grants. Explicit session-only
approvals are independent of Settings authorizations.

Revoking a session grant pauses the worker before removing access. That session
cannot automatically reacquire the revoked scope from Settings: another explicit
approval is required. Nested grants that remain are listed separately.

Unrestricted access requires an explicit per-session UI action. It disables
filesystem/network sandboxing for that session; the header retains the indicator.
Restoring scoped access pauses the worker. Restricted terminal views are observers;
native CLI handoff is available only for an unrestricted session at rest. Return
from the terminal before changing its access.

Legacy directory lists migrate to read/write authorizations. The global Cowboy
flag is retired and displayed as a migration notice in Settings. It does not
make new sessions unrestricted. Old managed sessions derive scoped grants on
resume; an already-running unrestricted terminal remains visibly unrestricted.

Network policy retains the providers' managed proxies, explicit localhost and
loopback denials, no local binding, and no unrestricted Unix sockets. This change
does not add per-service network grants or a new network proxy. Filesystem access
requests cannot enable those capabilities.

## Verification

- `bun test test/workAccess.test.ts test/workPermissions.test.ts`
- `bun test test/workSessionMilestone.test.ts test/workSessionTerminal.test.ts`
- `BIGBRAIN_TEST_NATIVE_PERMISSIONS=1 bun test test/workPermissionsNative.test.ts`

The native probes use disposable folders and fake model responses. They verify
read/write grants, read-only grants, outside-file and symlink denial, control-file
protection, and localhost blocking in installed Codex and Claude runtimes.

`/dev.html?c=permissions` renders the production settings and worker-access
components against simulated API state. No preview action changes real permissions.

## Pilot local work

Pilot now uses the same `SessionAccess` grants and Settings authorizations as
workers. Its access indicator and approval card live in the Pilot conversation;
there is no separate Pilot authorization list. New and migrated Pilot sessions
start with scratch only. Switching a model/backend preserves session grants.
Workers still receive their own selected project and scratch, never an implicit
copy of their parent's grants.

Pilot can call `list_directories`, `request_access`, and `run_command` to identify
projects, read/search files, edit, and run tests. It is instructed to inspect
candidate READMEs and project instructions before selecting a project, ask when
the target remains ambiguous, do small tasks itself, and delegate sustained work
or explicit requests for an agent. The relevant findings are attached to workers
through the existing retained-evidence context.

Every Pilot backend uses the same application command runner. The model's native
shell and approval tools remain disabled. The runner uses the installed Codex
app-server solely as an OS sandbox, with `codexWorkPolicy`; no model turn,
subscription, or API key is needed for a local command. Missing/unsupported
sandbox runtimes fail closed with a tool error. Commands get a clean environment,
private HOME/TMPDIR, a 30-second maximum, and bounded output. Command runtime state
and Pilot permission/conversation records are protected from scoped commands and
workers. Public-host network policy matches the worker policy.

Each command receives a fresh immutable policy. A Settings-authorized access
request can therefore be applied between commands in the same model turn. Other
requests persist, interrupt Pilot, and block further tool actions until the user
allows or declines them. Decisions resume the existing conversation and original
task. Grant changes stop and drain outstanding commands before mutation; the
runtime's command termination API stops child processes before the server closes.
Interrupted command effects are recorded as uncertain and supplied to the model
on continuation so it can inspect state before retrying.

Settings narrowing pauses dependent Pilot sessions as well as workers. Pending
requests are retained across restart and excluded from automatic transcript
retirement. Restart never replays commands. Approval endpoints are UI actions and
are not in Pilot's tool list. Automatic worker-report synthesis cannot run local
commands or acquire access.

Additional checks: `bun test test/pilotAccess.test.ts`. The native suite also
checks Pilot's real sandbox, command environment, and cancellation. The production
Pilot UI can be inspected safely at `/dev.html?c=permissions&s=pilot-request` or
`/dev.html?c=permissions&s=pilot-project`; both use simulated API state.
