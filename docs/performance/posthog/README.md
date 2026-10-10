# PostHog dashboards

`python3 docs/performance/posthog/dashboards.py` emits three dashboard definitions
and nine insight payloads for the shipped telemetry schema. These are prepared
payloads, not confirmation that dashboards exist in the hosted project. The public
ingestion token cannot manage dashboards; use the connected PostHog integration
with project management permissions. No management credential belongs in the app.

Before applying, choose the owner's US BigBrain project and list existing dashboards
and insights. Reuse matching names/tags (`bigbrain-telemetry-v1`) instead of creating
duplicates. Execute each insight's `query.source` first to validate its HogQL in the
project. Then create/update the three dashboards and save each insight with
`dashboards: [dashboard_id]`. Re-run the saved insights and verify dashboard tiles.
Do not modify unrelated dashboards. The current repository has no hosted dashboard
IDs because management access was not connected during preparation.

Performance includes sample-weighted viewer CPU/RSS split by release, platform,
foreground and gardening; memory by engine age; request-weighted latency/failure
rates; and maximum coarse timer delay. Engagement includes distinct weekly engaged
installations and sums of explicit user-action counts. Background events and
`development` releases do not count as engagement. Queries use a fixed trailing
30-day window; first and last weekly buckets may be partial.

Integration health counts installations whose Granola or That Tracks polls are
failing, by error code, and lists those failing for six hours or more over the
last two hours of reports. Alert on that second insight returning any row: it is
an outage, on one installation or every one, that nobody has fixed.

The summaries cannot support request-level p95/p99, completed Pilot turns,
whole-app/GPU totals, or per-session leak conclusions. Engine-age memory curves
mix installations and sessions. Do not average pre-aggregated means without
weighting by the supplied sample/request counts. Early charts can be empty until
a telemetry-enabled app build is installed and users opt in.

Definitions follow PostHog's [dashboards API](https://posthog.com/docs/api/dashboards),
[insights API](https://posthog.com/docs/api/insights), and
[visualization schema](https://github.com/PostHog/posthog/blob/master/frontend/src/queries/schema/schema-general.ts).
