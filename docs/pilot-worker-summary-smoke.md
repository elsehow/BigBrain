# Pilot intake of Quick summaries — September 15–16, 2026

## Production decision

Production Pilot intake uses the full saved worker application transcript,
without a Quick summarization step. `lib/pilotWorkerReports.ts` freezes saved
messages through each completion or failure, including task, corrections,
activity, and the full final report. Snapshots persist under the existing event
key across failed delivery and restart. Duplicate completion receipts are omitted
from the prompt. Questions and approvals remain immediate.

Legacy events are upgraded from the saved worker session. If it is missing,
the receipt is labelled incomplete. This preserves once-only delivery,
reporting-only permissions, and cancellation. Large transcripts can still hit
provider limits; that is a visible failed Pilot turn, not an automatic summary
fallback. Historical validation recorded 2,000 passing tests and three skipped
live-provider checks.

## Historical measurements

These aggregate results came from a private completed worker. Original task
text, worker/session identifiers, source excerpts, exact outputs, and individual
review decisions have been removed from this document and the workbench fixtures.
The current synthetic fixtures do not reproduce these historical measurements.

All token columns below are Astra only. Calls used `gpt-6-astra` with low reasoning,
the Codex subscription transport, fresh ephemeral threads, and no tools. The
matched pair used a common neutral evidence wrapper; earlier trials used their
original wrappers, so the rows are not one controlled experiment.

| Condition | Samples | Astra input / output tokens | Astra time | Fresh Quick time |
| --- | ---: | --- | --- | --- |
| User-supplied full-transcript baseline | 1 reported | Unknown | 7.6 s reported | None reported |
| Six goal-diff summaries | 1 | 6965 / 129 | 7.45 s | Previously generated; excluded |
| Richer completion summary | 1 | 6251 / 180 | 12.11 s | 7.09 s |
| Verbatim selection, SDK structured output | 1 | 6669 / 188 | 9.88 s | 13.04 s |
| Verbatim selection, locally validated JSON | 1 | 6746 / 181 | 8.36 s | 1.89 s |
| Visible workbench log, human-edited | 2 | 6113–6116 / 90–101 | 7.90 s mean; 5.41–10.40 s | None |
| Full saved app transcript | 2 | 10108 / 172–185 | 8.24 s mean; 8.04–8.44 s | None |

The matched log input used about 39.5% fewer tokens, but omitted material details
and left a failed test unresolved in the response. The timing spread did not
establish a speed advantage. Full-transcript responses preserved more context
but were not perfectly stable either. The earlier richer summary used 5,076
Quick input tokens and 388 output tokens; serial Quick-plus-Astra time was about
19.20 seconds. These are small samples, not a general benchmark.

Failure modes included unsupported completion claims, loss of validation and
release prerequisites, definition mismatches, and omission of unresolved choices.
The evidence supported choosing full saved application messages for production
intake. It did not show that compact inputs are inherently slower, or that full
transcripts always produce better answers. Baseline payload, token usage,
reasoning settings, and warm/cold state were not fully recorded.

## Synthetic smoke tooling

`test/support/smokePilotWorkerMatched.ts` now compares the invented ATLAS
workbench log with that same fixture's complete messages. It makes no request to
a running app and reads no saved worker. The root argument supplies provider
configuration; invoking the script explicitly still consumes model usage:

```
bun test/support/smokePilotWorkerMatched.ts CONFIG_ROOT /private/tmp/NEW_RESULT.json
```

The script records synthetic provenance, runs the conditions in ABBA order, and
writes results outside the repository. Tests check exact fixture parity, identical
common context, uncut messages, exclusion of future messages, and no hidden extra
worker evidence in the visible-log condition. These checks do not call a provider.
