# Implemented prevention follow-up

The investigation below records **baseline behavior**, not the current patch.
The user subsequently authorized implementation in this isolated checkout.

## Changes

- Worker records now carry stable report envelopes in an atomic outbox alongside
  completion/failure/request state. Reporter registration and the existing 30s
  maintenance sweep replay delivery until the Pilot callback persists receipt.
  Missing recipients throw rather than silently accept. Callback loss after Pilot
  persistence replays the same key, deduplicated by Pilot history.
- Startup/maintenance and turn settlement reconcile pending reports. Successful
  prose no longer blanket-acknowledges a batch. Matching context resolution or
  `notify_user(reportKey=...)` acknowledges only that report. Runtime notification
  keys bind to report identity, independent of the model's proposed key.
- Prose-only attempts persist deadlines (30s, then 60s) and a three-attempt budget;
  unresolved reports then get one stable-key attention notification. Failed,
  interrupted and explicitly stopped/deactivated conversations escalate without
  resuming. Explicit stop intent persists, cleared only when accepting user input.
  No worker commands are replayed and report-turn tool authority is unchanged.
- Notification persistence itself is recoverable evidence of handling if the
  following disposition write is lost. Pending addressed payloads are no longer
  truncated to the last 30 historical reports.

## Regression validation (modified checkout)

From the sibling scratch folder, with its existing isolated `bunfig.toml` and
`isolation.ts` preload, via Python subprocess with explicit cwd:

- `bun test ../checkout/test/workerReportDelivery.test.ts`: **19 pass, 0 fail,
  77 assertions**, exit 0. All three prevention contracts are ordinary passing
  tests, not expected failures. Covers actual desktopRouteManifest construction,
  startup, concurrent questions, reports during active turns, capacity deferral,
  bounded retries, partial batch ack, explicit stops across restart, lost delivery,
  lost sender receipt, notification/provider failure, and deduplication.
- `bun <checkout>/node_modules/typescript/bin/tsc --noEmit --project
  <checkout>/tsconfig.json`: exit 0.
- `bun <checkout>/node_modules/oxlint/bin/oxlint --deny-warnings` on the six changed
  production files and the regression file: exit 0, zero warnings/errors.
- Exact commands/output: sibling scratch `report-validation.txt`.

Sandbox parent-directory discovery warnings remain in Bun output, but all test
assertions pass. Fixtures are retained in approved scratch because native cleanup
is unreliable here. No live vault/provider, browser, full CI, push or deployment.
Upstream freshness and incident attribution remain unverified. Older completion
records with **no envelope** cannot prove lost delivery and are deliberately not
invented as new reports; the outbox guarantee starts with patched state writes.
There is no silent/routine disposition tool yet: each unresolved completion must
be explicitly notified or eventually visibly escalated. Notification HTTP state
is tested; operating-system toast delivery is not.

## Integration boundaries

Required shared edits: `pilotChat.ts` report receipt/scheduling/maintenance and
notify_user branch; `pilotChatTypes.ts` report state; `pilotTransitions.ts` removes
blanket settled acknowledgment and adds a durable report-stop guard. The accept
helper clears that stop marker on accepted user input; the input-ordering branch
itself is untouched. Queue worker owns ordering and client delivery. Other edits:
`agentOrchestrator.ts`, `worker/types.ts`, `pilotNotifications.ts`. No catalog,
unread/status UI or launch recovery changes.

---

# Worker report delivery: baseline investigation

## Scope and provenance

Investigation and tests only; no production implementation, deployment, push or PR.
Baseline: `40bd4d492eee37551a938fc023b44d91832be1d3` (isolated checkout,
matching cached `origin/main`). `git fetch origin main` over the configured SSH
remote failed (SSH/proxy DNS/connection); upstream freshness and installed engine
revision are **not established**. No incident data or real vault content appears
in these fixtures. No live accounts or providers were used.

Read AGENTS.md, CLAUDE.md, CONTRIBUTING.md and docs/development-data.md. No nested
instruction files were found in the relevant source/test folders. The verification
skill under `.claude/skills/verify/` was sandbox-denied; its exact contents could
not be read. The harness unconditionally isolates vault discovery before imports.

## Conclusion

There is no evidence here that identifies a unique historical incident cause.
Report-envelope timestamps are not proof of persistence, callback delivery, model
dispatch or notification delivery. Deployed revision and incident turn/ack traces
were unavailable. In particular, do not label the incident a scheduler failure
solely because a user message preceded recovery.

The baseline does have independently reproduced failures:

1. An interrupted/failed Pilot accepts and persists fresh reports but cannot start
   an automatic report turn. A user turn that succeeds makes them eligible again.
2. Pending reports surviving restart do not get a startup or maintenance wake.
   Restart of an in-flight report additionally sets the Pilot to interrupted.
3. A model returning ordinary prose without replying/notifying still causes all
   that turn's report keys to be acknowledged. A context question can remain
   `needs-input` with no pending report and no notification.
4. Worker completion persistence and report delivery are not a durable outbox.
   An idle worker record containing a result, with no corresponding Pilot event,
   does not cause replay on reporter registration/restart.
5. Provider failure after notification leaves a durable single notification and
   a pending report, but the failed phase prevents automatic retry.

These are mechanisms capable of silent delay/loss, not attribution of a particular
incident. A missing or ineffective earlier model turn remains a competing cause.

## End-to-end production trace

| Stage | Baseline code / behavior |
|---|---|
| Production construction | `web/server.ts` selects `desktopRouteManifest(ROOT, ...)`; `web/desktopRouteManifest.ts` creates WorkHistory, AgentOrchestrator, then PilotChats. |
| Reporter registration | PilotChats constructor loads/restarts persisted sessions, then `external.setReporter(...)`. AgentOrchestrator only re-emits outstanding **access** requests on registration. |
| Maintenance | `pilotChatRoutes(chats)` calls `startMaintenance()`: immediate sweep then 30-second sweeps. These age/ingest sessions; they do **not** drain pending reports. Maintenance is wired; adding another call to start it is not a fix. |
| Worker question | `AgentOrchestrator.wait`: save `worker.request` and `needs-input`; install pending resolver; synchronous `emit(question)` callback. User decisions/access instead emit `decision`/`access`. |
| Worker completion | `dispatch`: persist agent result, save idle status, emit completion with a new random key. Envelope/key is not persisted with result as an outbox. |
| Pilot receipt | `externalReport` calls `transitionPilot(worker-report)`. Duplicate `workEvents.key` is ignored. New ordinary reports append history and pending key, then `change` atomically persists before scheduling effects. |
| Direct attention | Access/decision/native reports create durable bound notifications rather than scheduling a model turn. Context questions do not. |
| Wake | `scheduleExternal`: one `setImmediate`; returns if closed, settings changing, or four turns already running. `reports` transition additionally rejects running, explicitly deactivated, interrupted/failed, queued-input or empty-pending states. |
| Normal advancement | On answered settlement, startTurn's completion path schedules eligible sessions; a report received during a successful active turn drains afterwards. Capacity saturation alone recovers when another turn settles. |
| Model input | `run.reportReference`: last 30 historical workEvents **plus** the turn's separate `Address these report keys` list, current worker summaries and safety instructions. |
| Tool authority | Automatic turns reject launch/message work and allow only bounded context reads, context replies and notifications. `reply_agent` checks ownership and current context request; it cannot answer user decisions or approve access. |
| Acknowledgment | `settled(answered)` removes every key in `turn.reports`, regardless of whether any reply or notification occurred. No per-key disposition check. User turns do not themselves clear pending report keys. |
| Notification | `notify_user` uses a Pilot-scoped stable key; message and notification are saved together by `change(notify)`. Same-key calls return existing notification even across restart. Different model-selected keys are not semantically deduplicated. |
| Application delivery | `persist` emits ApplicationChanges invalidation; notifications appear in HTTP summaries/detail and notification route. UI derives notification list/toasts from refreshed chat summaries (`notifications.svelte.ts`). Initial snapshot populates list but deliberately does not toast every historical ID. Browser/native delivery was not exercised. |

Repeated historical keys in prompts are therefore **not sufficient evidence of
failed acknowledgment/dedup**. Compare `pendingAgentSessionReports`, `turn.reports`
and the prompt's addressed-key list, not simply all occurrences in workEvents.
Answered questions stay in historical input by design; `resolved` handles matching
worker-request notifications, not deletion of history.

## Executable reproduction and boundaries

`test/workerReportDelivery.test.ts` invokes the real `desktopRouteManifest`, not a
parallel mock scheduler or standalone reducer. The actual constructors, reporter
registration, route maintenance startup, worker dispatch/wait/save/emit, Pilot
receipt/turn lifecycle, tool authorization, notification persistence and HTTP
notification projection run against fabricated vaults.

Substitutions: scripted Pilot model runtime; scripted worker PiSession.turn;
worker executor supplies an empty read-only tool set rather than starting an OS
sandbox; unrelated category model disabled. Prototype spies capture the actual
instances and call through maintenance/registration. This is production
**initialization and application-path** coverage, not a full server socket,
provider SDK, OS sandbox, browser or installed-desktop test. Run this file alone.

| Scenario | Verified baseline result |
|---|---|
| Concurrent context questions, no new user input | Automatically answered, workers complete, pending keys drain. |
| Concurrent completions/repeated stable notification key | One durable notification; HTTP route and application invalidation see it. |
| Report during active successful turn | Persists immediately, runs after active turn; no second user message. |
| Four active Pilots | Report waits, then drains when capacity is released. |
| Fresh report to interrupted/failed Pilot | Persisted but no model dispatch after event-loop and maintenance turns; successful user input unblocks it. |
| Idle lifecycle dormancy | Fresh report runs. Not the same as explicit deactivation. |
| Explicit deactivation | Report cannot restart the Pilot. |
| Restart with pending report, including formerly in-flight turn | No startup/maintenance drain. In-flight becomes interrupted. |
| Saved completion without Pilot receipt | Worker loads idle; no report replay. |
| Worker restart with context wait | Request invalidated; worker interrupted, stale answer rejected. No worker operation replay. |
| Model successful but does nothing | Question remains pending in worker; report acknowledged, no notification. |
| Notification followed by provider error/restart/user retry | Existing notification survives; same-key retry stays singular. No automatic retry. |
| Duplicate report key | No extra model turn/history row. |
| Automatic report tries launch/message/write | Rejected; no authority expansion. |

Three `test.failing` acceptance contracts demonstrate the missing prevention:
startup drain; no silent acknowledgment of an unresolved context question; and
handling or visible escalation for reports received by failed Pilots. Bun reports
these as passes **because the assertions fail as expected**. They are not passing
fixes. Remove `.failing` when the corresponding prevention is implemented.

## Minimal patch recommendation (not implemented or claimed verified)

A prompt-only change or timer alone cannot cover the reproduced losses. Keep the
change confined to report delivery/lifecycle rather than unread/catalog/status UI.

1. **Persist a stable report envelope with the worker state change.** Store key,
   kind, owner, text/reference and original timestamp in the same atomic worker
   record as request/result. Replay unreceived envelopes at reporter registration
   and reconciliation; mark received only after Pilot persistence returns. A crash
   after Pilot save but before sender receipt is harmless same-key redelivery.
   Do not regenerate completion keys on replay. Preserve older results as history,
   not invented evidence of delivered notifications.
2. **Drain durable pending delivery independently of chat activity.** Use one
   bounded/fair pump at startup, report receipt, turn settlement, settings-unblock
   and maintenance/retry deadlines. Keep work queued when capacity is full. Persist
   attempts, next-attempt time and disposition; use bounded backoff rather than a
   tight retry loop. Do not depend on the next user message.
   Do not simply remove interrupted/deactivated guards: current interrupted phase
   conflates user stop, restart and provider failure. Preserve explicit stop intent.
   For stopped/failed/recovered contexts that cannot safely run, create one
   deterministic-key **attention-required notification** explaining that handling
   paused. For transient automatic-turn failures retry only restricted report
   handling, never worker commands or interrupted user turns. After a bounded
   retry budget, escalate once rather than silently leaving pending work.
3. **Acknowledge per-report disposition, not model success.** A context report is
   handled after a successful matching context reply, an explicit user escalation,
   or proven supersession. Completion reports need notify/silent-with-reason
   disposition (routine results need not all notify). A successful text response
   alone must not close an unanswered question. Reconcile actual current worker
   state before retry: reply may already have succeeded before a crash. Restarted
   worker context/user waits are no longer valid continuations; mark superseded
   and surface interruption, never recreate promises or replay operations.
   Use runtime-bound report/purpose keys for notifications and retain existing
   dedup. Reuse notification IDs across retries/restart; don't rely on the model
   inventing the same key. Separate pending addressed reports from bounded labeled
   history in prompts; do not delete audit history as a dedup fix.

Preserve access approval in user cards, task decisions in user cards, and context
replies under existing instructions. Report receipts or escalation notifications
must not launch tasks, approve access, send external messages, or create broader
permissions. Explicitly deactivated conversations should not be reopened by a pump;
route any allowed attention indication through a non-resuming durable disposition.

Acceptance before shipping: turn the three red contracts green, retain all positive
coverage above, and add crash-injection at worker-save/Pilot-save/sender-receipt,
reply-success/disposition-save and notification-save/disposition-save boundaries.
Include retry deadlines/backoff, permission-unblock, more than 30 reports, partial
batch disposition, model-chosen duplicate content with different keys, and explicit
stop across restart. The present harness does not verify those proposed changes.

## Incident evidence that would discriminate causes

Request only redacted records for the affected Pilot/workers/time interval, not a
vault dump:

- Engine build/revision and restart/stop/settings-change timestamps.
- `.spool/workers/<id>.json`: status, updated, request identity/kind, result message
  IDs, operation states (no task text needed).
- `.spool/pilot-chats/<id>.json`: phase/turn, pending report keys, workEvents keys,
  notifications keys/IDs, lifecycle/deactivation and revision. Current snapshots
  cannot establish former scheduling times; timestamped historical copies/events
  are needed if available.
- `.spool/pilot-timings/<pilot>/*.json`: startedAt/status, tool names and spans,
  runId. Automatic timing message IDs are random, not report-key joins; supplement
  with recorded model input or a sanitized addressed-key list if retained.
- `journal/model-runs/<month>/*.json`: matching run lifecycle, errors and provider
  dispatch/usage evidence; relevant action receipts for context replies, without
  replaying any action. Model completion alone does not prove report handling.
- Notification persistence and application-change/SSE reconnect/refresh evidence.
  A notify tool span alone does not prove its result was persisted or displayed.

Add future structured report-key trace events: persisted, received, wake requested,
wake deferred with reason, turn started, per-key disposition, retry scheduled,
notification committed. This makes model handling distinguishable from scheduling
and UI delivery. Current baseline has no complete durable trace of every wake.

## Validation and environment caveats

- `bun install --frozen-lockfile`: succeeded after replacing only existing proxy
  host `localhost` with `127.0.0.1` in the child environment (same port/enforcement).
- Normal `bun test` preload could not create `/tmp` fixtures. A scratch-only
  equivalent preload uses `mock.module('node:os', ...)` to redirect tmpdir and
  unconditionally sets BIGBRAIN_VAULT before imports. No repository preload changed.
- This environment strips shell-set variables for Bun subprocesses; the scratch
  preload also sets KEEP_REPORT_FIXTURES=1. Native recursive cleanup returned
  EFAULT after removing fixture contents, so final runs retain disposable fixtures
  in authorized scratch. No live directories were changed.
- From sibling scratch: `bun test ../checkout/test/workerReportDelivery.test.ts`:
  **13 normal tests pass; 3 expected-failure contracts reproduce their failures**
  (Bun summary 16 pass, 0 fail; 62 assertions). Permission-denied parent-directory
  discovery warnings are sandbox limitations, not application assertions.
- In a scratch copy with `.failing` removed, `bun test report-prevention-red.test.ts
  --test-name-pattern PREVENTION` exits 1 with exactly three assertion failures:
  zero startup dispatches, unresolved question with no pending report/notification,
  and failed Pilot with neither dispatch nor notification. This confirms failures
  are the intended contracts, not fixture setup errors.
- TypeScript `bun node_modules/typescript/bin/tsc --noEmit`: exit 0. Focused lint
  `bun node_modules/oxlint/bin/oxlint --deny-warnings test/workerReportDelivery.test.ts`:
  exit 0, zero warnings/errors after documented spy-instance-capture suppressions.
  Commands were launched via Python subprocess with explicit checkout cwd because
  direct shell Bun launches intermittently reported CouldntReadCurrentDirectory.
- Existing `pilotTransitions.test.ts`: 4 pass, 1 fail due to sandbox recursive
  cleanup EFAULT; not reported as a clean suite. Its behavioral assertions reached
  21 calls. No existing test/source was changed to hide that limitation.
- Git status shows only this document and the new harness (both untracked);
  no production edits or commits. Git also warns about denied unrelated paths.
- Full CI, real provider SDK execution, browser/native notifications and installed
  revision comparison are not verified. No production source files changed.
