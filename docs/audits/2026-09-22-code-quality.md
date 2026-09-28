# Architecture and code-quality audit — 2026-09-22

Audited `b87e303` plus dead-code cleanup `3464947`. This is a targeted review of
the TypeScript/Svelte application, especially the Pilot runtime, persistence,
provider discovery, UI refresh, and graph interaction boundaries. It also checked
the shared event-log, ingestion, projection, and model-session contracts. It is
not an exhaustive Rust, dependency-security, or browser-interaction audit.

The clearest problem is incomplete retirement of earlier designs: tests and
parameters survive after their runtime behavior is gone, while current behavior
is concentrated in large stateful modules. Several findings below are observable
bugs, rather than preferences about code style.

## Resolution status

All seven findings are implemented on `refactor/dead-code-audit`. The final code
includes main through `8e34683`; the findings below retain the original evidence
and recommendations, with original line numbers. The cleanup and each group of
runtime changes are separate commits for review.

| Finding | Implemented change | Regression evidence |
| --- | --- | --- |
| 1. Damaged history | One per-file loader isolates damaged Pilot, provider, worker, and research records. Runtime schemas validate live fields before recovery; the originals remain on disk and the UI reports affected files. | Desktop route-manifest tests include malformed JSON and invalid nested fields while a healthy conversation remains available. |
| 2. Stale credentials | The Responses adapter resolves credentials at each turn; unused key parameters are gone. | Two turns on the same warm session send the old and replacement keys respectively to a synthetic fetch. |
| 3. Read-time writes | Persistence is separate from activity timestamps. Recovery finishes before writing, writes only changed records, and preserves historical recency. | Two restarts preserve ordering, timestamps, and the recovered phase on disk. |
| 4. Full-history polling | The index returns summaries. `/api/pilot/chat/session` returns detail on demand, with coalesced reads and revision checks. Server-side search still finds unopened conversations. Hidden-window polls slow down; archive migration runs only at startup. | Payload test plus production-shell browser coverage of unopened history, concurrent detail loads, unchanged polls, and new messages. |
| 5. Discovery side effects | `modelCatalog` supplies one read-only provider snapshot to Pilot and curation. Only explicit connection actions apply preference policy. The two older discovery modules are removed. | Tests count one call per provider and prove GET model settings leaves vault configuration and environment files unchanged. |
| 6. Graph switchboard | Depth and hierarchy receive named frame inputs. `graphFrameState` makes their shared history/selection/overview precedence explicit. | Existing graph regression tests and production-shell hover, selection, and conversation-link browser checks pass. |
| 7. Retired modes | Removed `pilotsOnly`, the constant direct-mode branch, unproduced `nativeItem` handling, and worker notification state/adapter. Archive reads, redirects, and migration remain. | Existing archive migration/link tests and the production notification browser flow pass. |

The resulting boundaries are deliberately small: durable-record loading,
activity versus housekeeping writes, summary versus transcript reads, discovery
versus connection changes, and one shared graph frame decision. The live event
log, ingestion pipeline, and provider session contract remain the architectural
foundation.

**Payload comparison:** the same synthetic 100 conversations with 20 messages of
1,000 characters each serialize to 2,180,814 bytes as full sessions and 48,126
bytes as summaries, including the issue list: **97.8% less**. This measures the
wire representation, not production throughput. An unfiltered poll also skips
transcript text scanning entirely.

**Final validation:** 2,036 tests passed, 9 opt-in tests skipped, zero failures.
Engine typecheck, lint with warnings treated as errors, plugin checks, Svelte
checks (zero warnings/errors), and the production UI build passed. The existing
large-bundle warning remains. Tests used scratch vaults and synthetic provider
responses; no real-vault mutation or paid model call was needed.

Three Chrome checks passed against the production `AppShell` in the fabricated
sidebar workbench: `pilotSummary.browser.cjs`, `notificationActions.browser.cjs`,
and `hoverStable.browser.cjs`. The preview reports desktop version `0.7.25`.
The tested implementation was `c5099b5`, based on
main `8e34683`, with the audit fixes described above. The installed app reports
engine `9f915ef`; these are browser checks of the new implementation, not proof
about that older installed binary. Native opt-in sandbox/browser tests were not
run.

The broader `sidebarWorkbench.browser.cjs` stops at its home keyboard-navigation
assertion (line 85) on both this branch and a clean main `8e38172` checkout.
It presses J before returning home finishes. Waiting for that transition makes
the assertion pass, but the next assertion still expects the retired drawer
instead of the current memory preview. The targeted changed flows pass; the
broader script needs updating and is not counted as passing.
Tracked separately in [#906](https://github.com/elsehow/BigBrain/issues/906).

The #906 follow-up updates those stale interaction assertions and passes the
complete synthetic Chrome regression on main `340e774`. It also adds the script
to both Linux and macOS browser CI jobs, covering the production shell on every PR.

## Cleanup completed

- Removed the eight confirmed unused modules and `lib/workEvents.ts`, whose
  types also had no consumers. Removed the confirmed unused functions inside
  retained modules.
- Removed tests of the retired adapters, response formatter, memory helper, and
  graph-region model. Retained the independent tests of the live graph depth,
  hover history, and highlighting implementations.
- Moved the cross-vault isolation check onto `mcpServerEntry` and the public MCP
  server. Kept the speech session's exclusion of vault memory in `pilot.test.ts`;
  live Pilot memory-refresh coverage already exists in `pilotChat.test.ts`.
- Replaced documentation claiming the retired adapter still launches workers.
- Net reduction: 748 lines across 21 files, including obsolete tests/docs.

Validation of the initial deletion commit: 2,028 tests passed, 9 skipped, zero failures. TypeScript, lint,
plugin generation checks, Svelte checks, and the UI production build passed.
The build retains its large-chunk warning. The full suite required normal local
loopback and filesystem-watcher access; the restricted run could not exercise
those facilities. Opt-in native sandbox/browser tests were not run.

## Original findings, in recommended order

### 1. P1 — One damaged session record can prevent desktop startup

Locations: `lib/pilotChat.ts:190`, `lib/workHistory.ts:46`,
`lib/workHistory.ts:53`, `web/desktopRouteManifest.ts:19`, `web/server.ts:710`.

Both constructors parse every saved record without isolating errors by file.
`desktopRouteManifest` constructs both services before returning any routes.
A malformed historical worker record therefore blocks the current Pilot runtime,
even though workers are retired. A damaged provider continuation file can also
throw while Pilot history is loading.

**Reproduced:** seed two valid conversations in a scratch vault, replace one
JSON body with `{broken`, and construct `PilotChats`: construction throws a JSON
parse error instead of retaining the other conversation. A malformed
`.spool/work-sessions/work-<32 hex digits>.json` similarly aborts `WorkHistory`.

**Recommendation:** validate records independently, preserve the original damaged
file, report the affected conversation, and continue loading healthy history.
Do not silently replace corruption with empty history. Exercise this through the
desktop route manifest so the test proves the app remains available.

### 2. P2 — API-key refresh plumbing passes a value that is never used

Locations: `lib/pilotChat.ts:151`, `lib/pilotChat.ts:431`,
`lib/pilotChat.ts:446`, `lib/pilotChat.ts:558`, `lib/pilotBackend.ts:54`.

`send` reads the current key and passes it through `startTurn` to `run`, but `run`
never uses it. The cached Responses backend uses the key captured when the
runtime was first created. Updating the key in Settings does not refresh an
already warm backend. This is a concrete example of plausible-looking plumbing
that does not perform its apparent job.

**Reproduced without network:** use the actual Responses backend with a synthetic
fetch implementation, complete one turn, replace the scratch vault's API key,
and send a second turn. The vault contains the new key, but the second request's
Authorization header still contains the old key.

**Recommendation:** give credentials one explicit owner. Resolve the API key at
dispatch or invalidate affected cached runtimes on credential change. Remove the
unused parameter only as part of that fix. Test key replacement on the same
already-running conversation, not merely a fresh connection check.

### 3. P2 — Reading history changes timestamps and saves before recovery is complete

Locations: `lib/pilotChat.ts:193`, `lib/pilotChat.ts:213`,
`lib/pilotChat.ts:236`, `lib/pilotChat.ts:314`.

Every constructor load calls `save`, which increments the revision and replaces
`updated`. `list()` sorts by that timestamp. The constructor then changes
`working` to `interrupted` after the unconditional save; an already titled
conversation may therefore have different phases in memory and on disk.

**Reproduced:** conversations dated September 20 and September 10 both became
September 22 merely by loading. Their list order reversed because the older
conversation was loaded later. Separately, a saved working conversation became
`interrupted` in memory but remained `working` on disk after construction.
`lastActivityAt` remained intact; consumers that use that field avoid the recency
problem, but list ordering and displays using `updated` do not.

**Recommendation:** separate record loading/normalization from recording user
activity. Finish restart recovery before persisting, write only changed records,
and preserve historical timestamps for housekeeping-only changes. Test disk state
and ordering across two restarts.

### 4. P2 — Every status refresh transfers all conversation history

Locations: `lib/pilotChatRoutes.ts:29`, `lib/pilotChat.ts:314`,
`web/ui/src/lib/pilotChat.svelte.ts:82`,
`web/ui/src/components/AttentionControls.svelte:80`.

The status poll returns complete sessions, including every message and dormant
conversation. It runs 300 ms after completion while any Pilot is working and
1,500 ms otherwise, including while the window is hidden. Client revision checks
avoid some reactive work, but occur after the payload is serialized, transferred,
and parsed. Each list also reruns the legacy migration traversal; the separate
notification poll calls `list()` again.

**Measured on synthetic data:** 100 dormant conversations, each containing 20
messages of 1,000 characters, produced **2,209,404 bytes per response**. At the
nominal intervals that represents about 7.36 MB/s during work or 1.47 MB/s idle,
excluding response time and transport overhead. These are payload estimates,
not a benchmark of the user's vault or measured network throughput.

**Recommendation:** poll lightweight summaries/revisions, fetch transcripts for
opened conversations, and deliver live updates only for changed sessions. Move
one-time archive migration out of the ordinary list read. Preserve revision and
optimistic-write protections already present in the client.

### 5. P2 — Opening a model menu can update unrelated model preferences

Locations: `lib/pilotModels.ts:8`, `lib/workAgents.ts:32`,
`lib/workAgents.ts:39`, `lib/modelPreferenceRefresh.ts:8`.

The GET model-list path calls `connectedWorkAgents(root, true)`, which performs
`refreshModelPreferences`. When the discovered provider set changes, that helper
writes gardener, memory, quick, and future-Pilot preferences. The model menu also
calls `piModels()` directly while `workAgents(..., true)` calls it again, creating
two independent discoveries for one response.

**Evidence:** traced call chain and existing
`test/modelPreferenceRefresh.test.ts`. Resetting defaults when connections change
is explicitly tested policy; the finding is its placement inside discovery,
not a claim that the reset policy was accidental. The comment in `pilotModels`
says discovery is separate from curation, but its execution mutates curation
configuration.

**Recommendation:** obtain one read-only provider snapshot. Apply connection-change
policy in an explicit connection/settings operation, separate from rendering a
menu. Add a read-only model-list test that checks the vault files stay unchanged.

### 6. P2 — Graph rendering has a 19-argument behavior switchboard

Locations: `web/ui/src/lib/graphDepth.ts:83`,
`web/ui/src/components/LinkGraph.svelte:1027`.

`GraphDepth.step` takes 19 positional arguments: booleans, indices, optional sets,
style objects, and optional arrays. Its live call combines inline ternaries,
`undefined` placeholders, selection, history, unread state, and Pilot context.
`LinkGraph.svelte` is 2,116 lines and assembles these behaviors in its frame loop.
The removed GraphHoverRegion tests illustrated the maintenance risk: a whole old
interaction model still appeared supported by tests after production stopped
using it.

**Recommendation:** first replace the positional interface with a typed frame
input object. Then calculate one explicit view state before animation/rendering,
with defined precedence for selection, hover, overview, and Pilot context. Keep
existing animation and browser regressions; do not introduce a generic graph
framework or split files merely to reduce line counts.

### 7. P3 — Retired modes still appear configurable

Locations: `lib/pilotChat.ts:48`, `lib/pilotChat.ts:57`,
`lib/pilotChat.ts:73`, `lib/pilotChat.ts:146`,
`web/desktopRouteManifest.ts:20`, `bin/pilotDev.ts:16`.

Callers pass `pilotsOnly: true`, but the option is never read. Both functions
accepting `_pilotsOnly` ignore it, and runtime creation hardcodes `direct = true`.
These switches imply alternatives that no longer exist. Additional old paths
remain: `nativeItem` has no producer in the current provider adapters, and worker
notification code retains delivery comments and state after the corresponding
producer was removed. Historical record support is useful; simulated live-worker
machinery and meaningless switches are separate concerns.

**Recommendation:** remove no-op options and unused event branches. Consolidate
legacy reads behind the archive/migration boundary while preserving old links,
receipts, and conversations. Check workbench fixtures separately so fixture-only
behavior is not mistaken for an application requirement.

## Guardrails and scope

- Lint now fails on warnings (`--deny-warnings`) while retaining its explicit
  source-directory list and Svelte exclusion.
- TypeScript now enables `noUnusedLocals` and `noUnusedParameters`. The unused
  runtime key and `tendPrompt` root arguments were removed. These checks still
  cannot prove that every exported module has a production consumer.
- Shared immutable event logs, the common landing pipeline, and the common model
  session contract have identifiable responsibilities and live consumers. This
  pass did not find a reason to replace those abstractions. The strongest evidence
  points to incomplete retirement and state ownership around Pilot and UI code.
- The three runtime reproductions and polling measurement used disposable local
  vaults and synthetic Responses output, with no model requests or real-vault
  access. The subsequent fixes and validation are recorded above.

The implementation follows that sequence in separate reviewable commits after
the initial dead-code deletion. The draft PR remains open for review.
