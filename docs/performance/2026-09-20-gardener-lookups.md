# Gardener lookup batching — 2026-09-20

Issue #850. **Keep the production prompt unchanged.** Explicitly asking Claude to
gather independent context together did not improve this cohort's latency. Both
treatment runs were slower than both contemporary baselines. This is a negative
experiment, not a claim that batching cannot help other workloads.

## Intervention and method

Inspection of the two earlier #842 Claude transcripts found that multi-query
searches and multiple tool calls per assistant message already occur. Some known
body-tail reads and staged opens happened several turns after their paths/ids
were available, however. The experiment added this paragraph after loop step 2 in
`prompts/tend.md`, with no other prompt or runtime changes:

> Gather independent context in the same turn: group known search queries in
> one `search_vault` call (separate calls when filters differ), and request
> known missing body sections and needed staged opens alongside those searches.
> Use the batch's supplied paths, lengths and ids; do not wait for a search
> result to request a read that does not depend on it. Follow up separately
> when a result reveals a new entity, path or ambiguity. This does not reduce
> the evidence needed to file a claim or settle an item.

Engine: 646529b. Four fresh clones of the same marked, unprocessed #842 cohort:
six intake arrivals, two staged messages, 3,448 prior sources, 4,905 assertions,
and 715 entities. Order: baseline, treatment, treatment, baseline. Only the
paragraph changed. Claude Code subscription / `opus` / default effort, resolved
as `claude-opus-5` in all four transcripts. No memory pass or live-vault writes.
One model job ran at a time; normal engineering activity continued, so this is
not a quiescent-machine benchmark. Provider latency, generation length, cache
behavior and model choices remain sources of variation. Four runs on one cohort
are not a population estimate or an independent retrieval-quality evaluation.

The companion JSON records prompt SHA-256 hashes, aggregate tool timelines and
tool groups. A group is tool calls sharing an assistant message ID; it does not
prove simultaneous host execution. SDK-reported turns use different accounting
and must not be equated with model round trips or tool groups.

## Results

| Run | Prompt | Total | First new claim | Claims | Tool groups | SDK turns | Rejected items | Admit / pass |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | baseline | 138.46 s | 74.81 s | 14 | 14 | 18 | 0 | 1 / 1 |
| 2 | treatment | 154.45 s | 83.62 s | 16 | 11 | 17 | 0 | 1 / 1 |
| 3 | treatment | 200.35 s | 93.77 s | 16 | 13 | 17 | 4 | 0 / 2 |
| 4 | baseline | 131.29 s | 40.34 s | 14 | 13 | 18 | 0 | 0 / 2 |

Baseline averaged **134.88 s** total and **57.58 s** to first filing. Treatment
averaged **177.40 s** total and **88.70 s** to first filing. All runs drained both
queues. Shared handlers occupied only 1.74–2.90 s per run.

The intervention partly changed scheduling: run 2 grouped the missing-body read
with its initial searches, and used fewer tool-calling messages. Run 3 delayed
that read to the next context group. Neither improved first filing or total time.
Run 4 filed a ready item's claim before the remaining batch, producing the
fastest first filing without the intervention. Waiting for all context before
filing is not necessarily the best schedule for first-useful-result latency.

Run 3's four rejected items were entity guard corrections: one new person's name
resembled an unrelated existing institution; three assertions tried to create a
full name alongside an existing first-name entity. The model resolved the former
as genuinely new and read the latter's dossier before reusing its ID. This cost
extra calls and generation; the guards should not be weakened to improve a timer.
Run 2 was also slower without any rejection, so retries alone do not explain the
negative result. No claim is made that all time outside handlers is reasoning.

## Filing quality

A single nonblind review read all 60 new claims, compared six-source coverage,
entity choices, dates, commitments, admission decisions and source attribution,
and spot-checked numeric/technical statements against the source passages.
Every intake source was represented in all four runs. Main dates, commitments
and conclusions were preserved, and requests were not promoted to completed work.
Both arms varied between admitting an onboarding message and passing it; each
arm had one run of each decision. These are relevance choices, not queue failures.

Treatment produced more detailed claims, not necessarily better retrieval. One
technical treatment summary overgeneralized a matrix transformation as always
right-multiplication, although the source has both left- and right-multiplication.
Entity resolution and confidence also varied: a baseline explicitly qualified a
person match that a treatment treated as established after reading prior context.
This review does not establish equal quality or absence of errors. It provides
no quality-based reason to adopt the slower prompt.

## Decision and reproduction

Discard the added paragraph; production prompt, model defaults and tools remain
unchanged. #850's effort comparison, live progress, completion-tail assessment,
and lookup-batching experiment are now recorded. Entity-resolution correction
overhead is tracked in #854 as a more specific follow-up, requiring its own identity-safety
and false-positive tests rather than a blanket reduction in checking.

To reproduce, use engine 646529b and a marked unprocessed scratch snapshot:

```
bun test/support/profileGardener.ts clone <snapshot> anthropic
bun test/support/profileGardener.ts run <fresh-clone> --live
```

Use a new clone each time. Run baseline / added paragraph / added paragraph /
baseline; restore the prompt after the experiment. The existing profiler records
first non-deduplicated assertion filing, full run completion and tool timings.
Group tool-use records by assistant message ID in the private SDK transcripts.
Raw sources, claims, identifiers, search queries and transcripts are not included
in the committed artifacts. No additional hosted telemetry was added.
