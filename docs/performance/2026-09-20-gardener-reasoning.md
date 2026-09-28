# Gardener reasoning and live progress — 2026-09-20

Issue #850. Keep the OpenAI gardener recommendation at Astra/medium: this small
comparison does not show a reliable total-time benefit from low reasoning.

## Comparison

Four fresh clones of the same unprocessed cohort from #842: six intake sources
and two staged arrivals, with the same prior record (3,448 sources, 4,905 assertions,
715 entities). Runs were sequential in medium / low / low / medium order, using
Astra through Pi's `openai-codex` subscription runtime. The prompt, tools, input,
and model were fixed; only the configured reasoning level changed. The production
adapter passes that level to Pi and rejects unsupported values. No live-vault
writes, API billing fallback, or memory pass.

The benchmark checkout was frozen at 105f98d while UI implementation continued
elsewhere. Timings include runtime startup, model inference/network waits and
shared tool execution. The machine was not quiescent, and provider latency varies;
these are four observations on one cohort, not population estimates.

| Run | Reasoning | First new claim filed | Run complete | New claims | Turns | Rejected submissions |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | medium | 36.39 s | 72.70 s | 12 | 10 | 0 |
| 2 | low | 32.85 s | 65.18 s | 10 | 10 | 0 |
| 3 | low | 32.81 s | 76.36 s | 11 | 9 | 0 |
| 4 | medium | 33.95 s | 66.58 s | 10 | 10 | 0 |

Low averaged 70.77 s total versus medium's 69.64 s. First filing averaged 32.83 s
versus 35.17 s: about 2.34 s earlier, but total-time ranges overlap and one low run
was the slowest. All runs drained the queues and passed both staged items. None
had validation retries or identical repeated submissions.

## Quality review

One nonblind reviewer inspected all 43 new claims and compared source coverage,
entity matching, attribution, request-versus-completion distinctions, and specific
numeric/technical claims against the source text. All six intake sources were
represented in every run. Main commitments, dates and source conclusions were
preserved; neither level treated a request as proof that the requested work had
been completed. Existing entity identities were used consistently. Both levels
varied in which supporting examples or technical details they kept. No material
grounding failure was found in this review.

This is a coverage and grounding spot-check, not an independent gold-standard
retrieval evaluation. The result supports keeping the current default, not a
claim that medium has proven better quality. Existing saved settings are unchanged.

## Where the time goes

The tool timelines contain two work batches, two context searches, one body read,
and usually one staged-item open. One low run skipped that open. The host's tool
handlers occupy only a small fraction of total time; the large gaps occur before
submission. Time outside handlers must not be labeled entirely as reasoning: it
also includes inference, network/provider waits and runtime overhead.

The final empty `next` was followed by 2.64–3.66 seconds before completion. A host
completion shortcut could save that tail, but is not implemented here: a successful
early stop must preserve provider usage accounting and distinguish cancellation
from completion. The observed saving is small relative to the whole run. This
comparison did not establish a safe, materially faster batching policy either.

## Live progress

A single observer around the shared host tools now supplies local progress for
Pi, Claude Code and the retained Codex adapter. The top bar shows the current
activity, batch size, new claims filed and whether it is waiting for the model.
It follows the existing chrome reveal behavior and disappears on completion or
connection loss. The tooltip includes last activity time.

Only counts, fixed phases and timestamps cross the local SSE connection. Source
text, search queries, model prose, paths and source identifiers are excluded.
Nothing new is sent to hosted telemetry. Status lives inside the gardener's
PID-owned lock and is removed when the round ends; a dead/mismatched owner cannot
present stale progress. Atomic status changes use a dedicated SSE event, never a
content revision or graph/index invalidation. The existing heartbeat also clears
a crashed holder's status.

The profiler now records a safe tool timeline and time to first successful,
non-deduplicated assertion. Declines do not count as claims. Gardener journals now
record the actual configured reasoning level, rather than an empty placeholder.

## Reproduction and validation

```
bun test/support/profileGardener.ts clone <marked-unprocessed-snapshot> openai low
bun test/support/profileGardener.ts run <new-snapshot> --live
```

Use fresh clones for each run and `medium` for the comparator. Shared-tool tests
cover counts, retries, deduplication, privacy, lock ownership and observer failures.
The actual filesystem watcher test verifies that progress changes reach SSE
without projection refresh or graph warming. The production-UI browser fixture
checks visible counts, narrow-window layout, completion/disconnect cleanup, and
no graph refetch on a progress event. Private inputs and transcripts stay outside
the repository; the companion JSON contains aggregate measurements only.
