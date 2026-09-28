# Local performance diagnostics and opt-in reporting

Diagnostics shows a rolling hour (360 samples at ten-second intervals) of viewer
engine CPU/RSS, coarse timer delay, foreground/background state, and whether the
gardener lock is held. These are process measurements, **not whole-app totals**:
they exclude the native shell, WebView, API service, supervisor and model processes.
GPU still requires local native profiling. CPU is normalized to one core (100%),
not all machine cores. Sampling windows of 30 seconds or longer are omitted because
sleep and long stalls cannot be distinguished with this sampler. Foreground means
visible and focused, not necessarily recently interactive; its heartbeat expires.

Request summaries cover search, graph, note reads and Pilot input acceptance:
count, mean/max elapsed server response time and failure count, grouped by gardener
state at request start. Pilot acceptance is **not** time to first token or completed
turn latency. HTTP transport/renderer delays, queue wait, and background work that
starts mid-request are not separately measured. Ten-second timer drift is only a
coarse contention signal. Use targeted profiling for short UI stalls.

Usage summaries count explicit `gotoNote` navigation and accepted Pilot inputs,
not all note fetches or background gardening. These hooks do not cover every way
of viewing a note. Pilot input IDs deduplicate the most recent 1,000 inputs in
memory; IDs themselves never leave the machine. A restart can permit a duplicate.
Keep those counts separate from uptime and foreground state in engagement charts.

## Consent and delivery

Sharing defaults off. New-vault onboarding offers an optional fifth step,
**Help improve BigBrain**, after Vault, Providers, Clients and Integrations.
Both **Opt-in!** and **No thanks** persist a decision on this
installation; existing valid opt-in/opt-out preferences count as answered.
Completed and legacy vaults bypass onboarding, including installations without
a decision. Builds without hosted reporting skip the prompt. Settings → Diagnostics retains the
sharing toggle. The installation preference lives in
`~/.config/bigbrain/telemetry.json`, outside every vault, mode 0600. A random
installation ID is created only on opt-in. This is pseudonymous, not guaranteed
anonymous. Revoking consent clears unsent events and the ID, aborts an in-flight
request, and resets aggregates. Already delivered data is not deleted by opt-out.
Local numeric diagnostics remain available with sharing off. No old local history
is uploaded when consent is enabled. Consent changes reset the CPU measurement
baseline and aggregates; operations begun before the change cannot enter the new
reporting window. Queue and local history are memory-only.

One engine-owned sender uses PostHog's batch API every five minutes. Events have a
versioned, explicit schema: numeric resource/operation summaries and action counts,
OS family/architecture, engine commit (or `development`), random event IDs and
installation ID. There are no paths, vault IDs, titles, queries, prompts, responses,
raw errors, or logs. Autocapture and replay are not loaded; person profiles and
GeoIP enrichment are disabled. Like any direct HTTPS service, PostHog receives the
connection's IP address. Delivery uses a ten-second timeout, no redirects, one
in-flight batch, at most 100 queued events, and a 24-hour event expiry. Failures
retry on the next five-minute tick. Events have stable UUIDs across retries.

## Project setup

Create a PostHog Cloud project. Supply its **public project token** and region
(`us` or `eu`), never an admin/personal API key. Put the public settings in
`lib/telemetryConfig.ts` for shipped builds. Development overrides are
`BIGBRAIN_POSTHOG_TOKEN` and `BIGBRAIN_POSTHOG_REGION`. Configuration alone does not
enable collection sharing. With no token, local diagnostics work and no upload is
attempted. No Supabase service or browser SDK is needed.

Suggested dashboards:

- Performance: `desktop_resources` CPU/RSS versus engine age, by release, OS,
  foreground and gardening; `desktop_operation` mean/max latency and failures
  split by gardener state. Weight means by `samples` / `count` when aggregating.
  These summaries do not support request-level p95/p99 estimates.
- Engagement: distinct installations with `desktop_usage` each week and returning
  installations; action counts for `note_opened` and `pilot_input_accepted`.
  Exclude `release = development`. Opt-in installations are a selected sample.

## Verification

`bun test test/telemetry.test.ts` checks default-off, consent persistence/reset,
allowlisting, retry deduplication, opt-out during upload, bounded queues/history,
CPU units and resume gaps, plus same-origin mutation protection.
`bun test/support/profileTelemetry.ts` measures collector cost against a synthetic
empty vault without network. On the development Mac, 10,000 accelerated sample
iterations measured about 3.3 microseconds wall time / 3.6–3.7 microseconds CPU per
sample, with 360 retained samples. This microbenchmark excludes browser heartbeat,
HTTP traffic, upload costs and the native process overhead; it is not a whole-app
idle profile. Production samples once every ten seconds.
