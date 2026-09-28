# Simplifying BigBrain around Pi

Implementation status (2026-09-26): onboarding/design landed in #992/#994,
Responses retired in #999, fixed roles unified in #1000, sandboxed tools landed
in #1001, and project authorization/worker cutover landed in #1002. The final
cleanup removes native dependencies, redundant continuation/input paths, and
whole-vault memory sweeps. See [the shipped runtime contract](../pilot-providers.md).
The audit below records the pre-migration rationale and inventory.

Design follow-up to #993 and [the permissions proposal](pi-permissions.md).
Audited on 2026-09-26 against fetched main `bedf326f`; #992 supplies the pending
Claude subscription connection work. These are concrete candidates, not a
claim that all code named below is dead or that the migration has happened.

The intended architecture has three clear owners. Pi owns model conversations
and the agent loop. BigBrain owns curation, source access, user-visible work,
and permission decisions. A reusable execution sandbox enforces worker file
and command boundaries. Each role supplies a task profile to the same session
layer; the domain workflows stay distinct.

## 1. Remove redundant backend selection layers

Today `pilotBackend.ts` selects a backend, `sessionFactory.ts` selects another
session implementation, and `pilotBackendTypes.ts` aliases the shared session
interfaces. Workers have a separate native runner family. After #989 and #993,
replace backend registries with one small Pi session service used by Pilot,
background jobs, and workers. Keep useful seams for monitoring, host tools,
validation, and test injection; remove factories whose only purpose was
choosing an implementation that no longer exists.

A new request should describe its profile, selected provider connection/model,
input/context, output bounds, and cancellation. It should not require a caller
to know an adapter, native thread protocol, or provider-specific tool prefix.

## 2. Use direct calls for BigBrain's own tools

`claudeSession.ts` builds an in-process MCP server to expose host tools to the
Claude SDK. `AgentOrchestrator` provisions a managed Connected Client and
subprocess MCP connection for each native worker. Pi supports host tool
callbacks directly; internal calls can carry the run identity and scope
without creating a pretend external client, bearer token, or MCP transport.

Keep one implementation of each vault/source operation, with authorization and
attribution at its boundary. The external MCP server remains an adapter over
those operations for actual Connected Clients. Preserve client revocation and
independent filesystem-authority semantics for those external clients.

This removes transport and credential lifecycle work from ordinary execution
without conflating trusted in-app identity with external client authentication.

## 3. Give private model history one owner

`PilotConversation` currently carries `apiTurns`, `threadId`, `piSession`,
`runtimeId`, `through`, and previous native thread IDs. `ModelSessionTurn`
accepts complete messages, a separately reconstructed input, reference text,
and a native-request callback. `trimApiHistory` is another history manager.
#989 removes the Responses history manager; Pi-only execution allows the
remaining continuation contract to become Pi-specific and much smaller.

Pi should own model/tool history and compaction. BigBrain keeps public messages,
attachments, notifications, task relationships, evidence provenance, and action
receipts. These are different responsibilities: exposing Pi's private transcript
as the app conversation would risk exposing internal/tool/provider details.
Some public-history projection is therefore deliberate, not duplication.

Build one typed context packet per run/turn and remove redundant backend input
representations. Retain explicit rules for refreshing memory/context, applying
permission changes, and starting a fresh session after a contract change.
Old histories can be read through an archive decoder without reconstructing a
live native session or replaying its effects.

## 4. Separate current work from historical formats

`WorkSession` and `workAttention` currently accommodate native attach/resume,
terminal status, raw native approval methods, old per-session grants, migration
pointers, and historical handoffs alongside current work. New Pi work should
have one small live record with session identity, role/origin, status, effective
scope, public messages, pending user request, outputs, and receipts.

Normalize old saved records into a read-only display shape at one boundary.
Keep historical labels, evidence, and receipts readable without making every
live transition understand old protocol fields. Do not rewrite user vaults or
remove their history. The user's acceptance of fresh Pilot conversations makes
this practical without implementing a native-session conversion layer.

Use one application request shape for ordinary questions and one for access
requests. Record who is allowed to answer each. Pilot can answer context
questions; it cannot authorize a worker's new permissions.

## 5. Make capabilities explicit and derive their presentation

The same tool lists and effects appear in `machineTools`, `pilotChatTools`,
reader sets, prompts, integration capability responses, and tests. Define
small fixed job profiles that select shared operation definitions. Keep
operation effects, argument validation, dispatch authorization, and the
user-facing capability summary consistent with that selection.

Avoid building a policy DSL or a second generic plugin framework. A short
exhaustive set of profiles and one parameterized worker profile are sufficient.
Select profile independently of model preference: a memory-model fold proposal
gets no tools. Unknown roles/profiles fail instead of defaulting to memory.

Remove Gardener's live-source tools and ambient extension discovery. Simplify
background execution to a fixed set of domain operations, so it needs no
permission dialog, arbitrary filesystem sandbox mode, or subagent scheduler.
These improvements can begin before the full Pi migration.

## 6. Replace whole-vault repair with bounded memory publication

`memoryRun.ts` snapshots dirty paths, scans Git status after model turns, reverts
newly dirty tracked paths outside its allowlist, and quarantines untracked
paths. Its comments document how this collided with arrivals and concurrent
writers. The current domain tools already move toward preventing those writes.

Once every memory execution path is confined to its owned files, remove the
need to infer authorship from whole-vault Git status. Validate and recover the
memory files the run owns, preserving citation/word-count/consistency checks,
journals, single-flight rules, and explicit publication. A staged memory tree
is a possible implementation if it simplifies safe publication; it is not a
reason to invent a general filesystem transaction system.

This is a candidate to prove with concurrent-arrival and failed-run checks,
not permission to delete recovery mechanisms on architectural confidence.
Pi's presence alone does not make concurrent curation safe.

## 7. Reduce model and settings state

Live text-model selection can become provider connection + model + reasoning.
The adapter is a constant and need not be a user choice or a field carried
through every new runtime object. Decode historical adapter identifiers at the
saved-config boundary. Pi supplies model discovery; retain BigBrain's role
recommendations, pinned choices, availability explanations, and capability
requirements. `modelRegistry.ts`'s native Claude fallback entries and terminal
flags can shrink after their consumers migrate; realtime voice stays separate.

There should be one place to connect subscriptions and choose models, one
place to authorize worker projects, and the existing integration account
settings for source access. Remove native executable paths, native config
precedence, CLI health probes, attach/resume choices, and duplicate runner
connection screens. BigBrain can show the permissions it actually enforced,
rather than interpreting another client's settings files.

Subscription/API billing, provider availability, reasoning support, and hard
budget guarantees remain real differences. Preserve them, including refusal
to silently substitute API billing or claim Pi enforces a hard API dollar cap.

## 8. One execution event path and one orchestration lifecycle

Use Pi session events as the input to the existing application monitoring and
work lifecycle. Share tool activity, cancellation, questions, follow-up delivery,
and settled-run handling across roles. Keep role-specific completion behavior
(curated publication, briefings, Pilot answers) above that common lifecycle.
Retain durable run journals, reported usage, independent account quota readings,
and action receipts; these remain useful when there is only one runtime.

Compare a delegation package with a thin use of Pi sessions behind BigBrain's
existing task lifecycle. Adopt a package only when it replaces that machinery
cleanly. Do not add plugin schedules, mission records, and a second status store
beside BigBrain's existing ones just because they are available.

## 9. Delete orphan bookkeeping and redundant protocol tests

Static search found `isMachineSession` has no production caller, while
`runSessionJob` still writes `.state/machine-sessions` and tests assert those
markers. Check supported external consumers and then retire the marker store
if redundant with the current run journal; retain the session/run identity and
attribution themselves. This is an audit cleanup opportunity independent of Pi.
`newSessionAccess` is likewise used only by a test, while the old access shape
is still needed for archives; move fixture construction out of production.

Replace retired native protocol emulators with a smaller set of tests around
real Pi SDK integration, fixed-role authority, workspace containment, user
requests, cancellation, restart, and non-replay. Keep provider-specific auth
and usage checks where behavior differs. Business-rule tests for
curation, receipts, source revocation, and history remain valuable.

## Order and completion criteria

1. Finish the already-scoped #989/#992 work, then establish the role profiles
   and demonstrate a bounded Pi worker under #993.
2. Move every app-owned execution path and remove its native transport/client
   bridge, before simplifying the abstractions that supported multiple runtimes.
3. Collapse continuation state and live worker types while keeping one archive
   reader. Audit memory recovery and orphan bookkeeping separately with evidence.
4. Verify zero native CLI invocations on app-owned paths, one internal tool
   authorization path, one model-history owner, and one worker lifecycle owner.
5. Report production/test/dependency/bundle deltas after replacement code lands.
   The previous 701-line native-module inventory is only one category; it is
   not a net saving estimate. Complexity reduction must show up in fewer live
   states and ownership boundaries as well as fewer lines.

Sources for reusable runtime behavior:
[Pi SDK session, events, tools, and resources](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).
The file and caller findings above come from this repository at the stated
baseline; the linked permissions design and #993 contain the extension audit.
