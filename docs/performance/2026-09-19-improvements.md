# Quick and polling improvements — September 19, 2026

Claude Quick now completes the ten-connection synthetic benchmark in 4.4–8.6
seconds, versus prior successful runs of 33–43 seconds and one 60-second
timeout. The median of three new runs is 4.44 seconds. All new runs passed the
same JSON schema and citation/evidence validation.

## Cause and change

A trace of the old configuration showed 3,683 thinking tokens out of 4,094
output tokens. The first usable summary arrived at 31.4 seconds, with completion
at 32.7 seconds. This trace recorded phase metadata and token counts, not
thinking content.

No-tool background answers now use their supplied task instructions without
the general coding system prompt. When no reasoning effort is explicitly
configured, they disable extended thinking. Explicit reasoning choices still
take precedence. Interactive Pilot, gardener, and memory tools retain their
existing execution policy.

Quick also passes its existing output-token budget as a provider hint. Claude
applies it through the official runtime. Pi applies it where supported;
ChatGPT's subscription transport retains the hard host character bound. Hard
token-limit requests remain distinct and still fail if unsupported. Native
structured output, host JSON-schema checks, evidence checks, and final output
bounds remain active. Timeout failures now preserve the original deadline
reason rather than becoming a generic cancellation error.

| Trial | First summary | Complete | Output tokens |
| --- | ---: | ---: | ---: |
| 1 | 6.40 s | 8.59 s | 757 |
| 2 | 1.32 s | 4.37 s | 442 |
| 3 | 1.36 s | 4.44 s | 450 |

These are three short synthetic trials on the same machine and configured
Haiku alias, not production percentiles. Provider caching and network variation
contribute to the range. The official structured-output path still reports two
turns; it was not replaced with unvalidated free-form output.

## Polling

The page had independent session refresh loops in HomeView, Pilot, and the
attention controls, plus redundant initial/search refreshes. The attention
controls now own the single loop: 300 ms while a Pilot is working, 1.5 seconds
otherwise. Session refreshes continue while the window is hidden so they can
still drive notifications.

Archived history loads on initialization and explicit focus/retry, and retries
failed loads; it is no longer fetched every polling tick. Concurrent callers
share in-flight chat/history reads. Errors clear that shared promise so later
requests can recover.

A production-build browser check measured **4 session reads and 0 history reads
in six idle seconds**, down from 20 total in the baseline. History loaded once.
An active session received five refreshes in 1.5 seconds, with at most one
refresh in flight.

## Validation

- Full regression suite: 1,986 passed, 3 opt-in skips, zero failures.
- TypeScript check, Svelte check, and production build passed.
- Browser checks passed for polling, native Pilot approvals, and model settings.
- Adapter tests cover explicit reasoning, generation hints, hard bounds, schema
  repair, and keeping the interactive Pilot policy intact.
- Shared-refresh tests cover concurrent consumers, retry after failure, and
  later fresh reads.

[Raw timings and phase metadata](2026-09-19-improvements.json).

Reproduce the generation benchmark with:
`bun test/support/profileNoteBriefing.ts claude haiku live 10 3`.
Run `test/support/sessionPolling.browser.cjs` against the scratch dev app to
check refresh counts; it uses synthetic sessions and blocks writes.
