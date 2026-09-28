# Model-run monitoring

Every application-owned model turn has one durable run record under
`journal/model-runs/YYYY-MM/<uuid>.json`. `monitoredSession` wraps the existing
`ModelSession`: one session can serve many pilot turns, each with its own run.
Background jobs use the same wrapper. A nested tool-triggered run inherits its
parent ID, but retains its own role. Background journals and pilot timings link
to the monitor's run ID.

The wrapper records preparing, running, waiting for tools, and terminal states.
Usage snapshots are persisted as received, before the final answer or output
validation. A failed/cancelled run retains its reported consumption. Abrupt
process termination leaves its last observed phase; it does not manufacture a
terminal success. Monitoring write failures log a controlled warning and do not
fail inference. Records contain no prompts, outputs, tool payloads, credentials,
account email, or exception text.

## Adding an adapter or provider

1. Wrap each production session factory with `monitoredSession`, supplying its
   role and model setup. Keep role-specific tools and permissions in callers.
2. Emit typed `ModelObservation` values through `turn.observe`. Usage samples are
   replacement snapshots with a stable ID within the run. Never sum duplicate
   deliveries. Counts are disjoint input, output, cache-read, and cache-write;
   unavailable counts are null. Costs are list-price estimates, not billing.
3. Normalize cumulative provider totals in the adapter. Claude's modelUsage is
   cumulative across turns of one query; the adapter subtracts its previous
   reading. Provisional assistant reports preserve interrupted consumption;
   the result replaces those reports. Pi emits one sample per assistant response.
   Responses input includes cached tokens, which must be subtracted before
   adding the separate cache-read category.
4. Expose a stable, non-secret account identity when available. Claude hashes
   SDK account identity. Pi's public non-secret credential metadata currently
   exposes provider/type, not account identity, so its identity stays unknown.
   Never use a separately logged-in client account to supply a quota meter.
5. Declare quota capability in `PROVIDER_MONITORS` and emit quota window readings
   from that authenticated adapter. Undeclared Pi providers still get token
   accounting and an explicit unsupported quota state. No inference or login
   is triggered by the settings view.

`providerMonitoring` aggregates the new records for runs started in the last
seven days. `GET /api/usage.providers` supplies the common `ProviderMonitor`
contract to every connected-provider panel. The legacy top-level usage response
is retained for compatibility, but the new panel does not use its stale journals.
Old journals are not backfilled: their role coverage and account identity are
insufficient for combining safely with new observations.

## What the bars mean

The role bar shows reported BigBrain tokens, including caches, split among
pilot, gardener, memory, Quick, and any future role. Missing reports and unfinished
or failed runs are marked partial. Tokens are not a cross-provider cost unit and
are never converted into subscription quota percentages.

The separate account bar uses actual quota readings. BigBrain's segment is an
explicit estimate from first/last readings within a run, only within the same
reset window and identified account. Brackets overlapping another recorded run
are excluded. The first response, rounded readings, unrecorded work, and external
activity limit attribution. The remainder is 'Other or unattributed'. Unknown or
mixed identities suppress account quota; a single reading cannot establish a
share. Readings older than 15 minutes or past reset are stale.

Claude's adapter observes SDK quota events. Pi/ChatGPT currently supplies tokens
but no same-account quota source through this integration; its panel says so.
External connected clients are not application-owned model sessions and are not
counted from vault API calls. Their future telemetry must identify its provenance.

## Validation / preview provenance

Baseline: desktop 0.7.27, main 8fbed72e, matching installed BUNDLE at development
start. Browser fixtures mount the production AppShell via `/`, with synthetic
API responses and this branch's monitoring/panel changes. They do not access a
real vault or make model calls. `test/runMonitor.test.ts` covers aggregation and
lifecycle; adapter fixtures cover Pi and Claude observations; browser coverage
is `test/support/providerMonitoring.browser.cjs`.
