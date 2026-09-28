# Quick as an agent status log — September 15, 2026

This document retains aggregate measurements and engineering conclusions from
an offline replay of one private completed worker. Task text, session IDs,
source excerpts, and generated summaries have been removed from the repository.

The workbench (`/dev.html?c=agent+chat&s=quick-log&preview=1`) now uses an invented
table-export task. Target and imperfect summaries demonstrate the same UI states,
including missing updates, unsupported success claims, and replay cutoffs. They
are hand-authored examples, not the measured experiment's model outputs.
The `quick-goal-delta` and `quick-goal-full` scenes are also synthetic. Replay
never calls a model or resumes a worker, and scene labels show that provenance.

## Historical experiment

The configured Quick connection resolved to `claude-haiku-4-5-20251001` and ran
without external tools through the isolated briefing runtime. Six historical
cutoffs were used per trial: 75, 575, 850, 1300, 1710, and 1850 seconds after
launch. Later calls could see earlier summaries except in the final paraphrase
trial. Thinking blocks, injected memory, and MCP result bodies were excluded.

| Input / iteration | Non-empty entries | Mean latency | Result |
| --- | ---: | ---: | --- |
| App log, mostly tool names | 1/6 | 4.4 s | Almost silent until completion. |
| Native messages + excerpted results | 5/6 | 5.8 s | False commit and blocker claims. |
| Native, linked tool descriptions + tightened prompt | 6/6 | 5.6 s | Misdiagnosed a final test failure. |
| Public updates + tool descriptions, no results | 2/6 | 4.1 s | Too many omitted updates. |
| Public updates only, simple paraphrase | 5/6 | 2.3 s | Retained trivia and missed the opening update. |

Thirty successful generations cost approximately $0.37 in provider-reported
usage estimates, not a subscription invoice. One earlier formatting attempt
failed before these trials. The final trial ranged from 1.5 to 3.8 seconds per
update. One run does not establish general latency or reliability.

Two follow-up strategies shared the original goal and their own prior updates:

- `goal-full`: every normalized public event through the cutoff.
- `goal-delta`: events since the last published update. A null or rejected
  response does not advance that boundary.

| Strategy | Input tokens, six calls | Output tokens | Mean latency | Usage estimate |
| --- | ---: | ---: | ---: | ---: |
| Goal + prior + diff | 50,994 | 1,098 | 3.8 s | $0.153 |
| Goal + prior + whole | 207,007 | 2,000 | 6.1 s | $0.546 |

Totals include cache reads and structured-output repair turns. Both strategies
produced six entries. An aborted preliminary comparison with an unavailable
citation is excluded. Delta used about 75% fewer input tokens. Whole history
still confused definitions and reported passing tests before validation finished;
delta also speculated and overstated readiness. Neither met the reliability bar
for automatic live summaries. These measurements cannot be reproduced from the
replacement synthetic fixture.

## Engineering conclusions

Use runtime facts for lifecycle, permissions, and terminal ownership. Summary
prose must not set those states or delay questions and approvals. Preserve evidence
IDs and the worker's run/turn, coalesce bursts, reject malformed citations, and
keep edits, tests, commits, and deployment as separate milestones. Citation IDs
alone do not establish that a summary is supported by its evidence.

`lib/agentLog.ts` extracts bounded public evidence and validates JSON/citations.
Tests cover private-field exclusion, tool pairing, future-event exclusion,
accumulation after null responses, and both history strategies.
`bin/experimentAgentLog.ts` remains explicit offline tooling; it takes a vault,
saved worker ID, native JSONL path, and a new output path under `/private/tmp/`.
Its outputs contain private material and must stay outside version control.

Browser checks exercise both synthetic copy modes, the summarizing spinner,
hidden future excerpts, agent controls, stop confirmation, and narrow layouts.
All workbench APIs are fabricated. Production Pilot intake subsequently chose
full saved worker application transcripts; see [the intake decision](pilot-worker-summary-smoke.md).
