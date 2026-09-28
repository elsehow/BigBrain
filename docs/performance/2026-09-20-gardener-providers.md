# Gardener provider comparison — 2026-09-20

Issue #842. Provisional recommendation: GPT-6 Astra with medium reasoning through
Pi for gardening when both subscriptions are connected. Claude Opus remains the
fallback and an explicit selectable choice. This is a recommendation for the
measured workflow, not proof that one provider or agent runtime is generally best.

## Method

Four fresh clones of the same unprocessed #840 replay fixture: six intake arrivals
and two staged messages, with 3,448 sources, 4,905 assertions and 715 entities in
the prior record. Each clone has identical logs/staging and its own fresh git
repository. Only provider/model settings differ. Run order: OpenAI, Claude,
Claude, OpenAI. One model job at a time; no concurrent viewer probe or memory pass.
Normal engineering activity continued on the machine, so resource measurements
are observational, not a controlled hardware comparison.

Both paths use the production gardener prompt and role-scoped shared tools.
OpenAI uses GPT-6 Astra / medium via Pi's connected ChatGPT subscription. Claude
uses the configured `opus` alias / default effort through Claude Code; both SDK
transcripts identify `claude-opus-5`. These are existing role defaults, not
matched inference-effort settings. The comparison includes model choices,
provider behavior, agent transport and workload decisions together. It cannot
isolate "Claude Code overhead" from those other factors.

The fixture selection/replay limitations from the #840 report still apply:
previous claims citing the six selected arrivals were removed only in scratch,
but other current context remained. No credentials or original git history were
copied; no original-vault writes. Raw evidence, prompts, identifiers and generated
claims remain private. The companion JSON contains aggregates only.

## Results

| Run | Configuration | Seconds | Shared tools, s | Assertions | Rejected items | Admit / pass |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Astra / medium / Pi | 77.66 | 0.97 | 13 | 0 | 0 / 2 |
| 2 | Opus / default / Claude | 135.23 | 2.87 | 17 | 3 | 1 / 1 |
| 3 | Opus / default / Claude | 153.90 | 1.78 | 14 | 0 | 0 / 2 |
| 4 | Astra / medium / Pi | 76.36 | 1.18 | 13 | 0 | 0 / 2 |

All runs settled the eight initial arrivals and left both queues empty. No
identical retries occurred; run 2 corrected its rejected submissions. Mean wall
time was 77.01 seconds for OpenAI and 144.56 for Claude: **46.7% less time** or
about **1.88× throughput** on this cohort. OpenAI completed 6.18–6.29 initial
arrivals/minute; Claude completed 3.12–3.55. An admitted staged item is counted
once, although it then requires extra filing; final work performed differs.

The first tool started after 4.19/4.36 seconds on OpenAI and 4.82/2.99 seconds on
Claude. Shared handlers occupied 1.2–2.1% of total wall time. The measured gap is
therefore not explained by a large Claude startup delay or local tool time.
Outside-handler time still includes network, inference, transport and runner work.
Changing Claude effort or models would require a separate quality-aware comparison.

| Usage | OpenAI runs 1 / 4 | Claude runs 2 / 3 |
| --- | --- | --- |
| Turns | 10 / 10 | 17 / 16 |
| Uncached input tokens | 29,775 / 28,408 | 30 / 26 |
| Output tokens | 1,830 / 1,740 | 11,553 / 12,767 |
| Cache-read tokens | 164,608 / 155,648 | 593,755 / 521,226 |
| Cache-write tokens | 0 / 0 | 57,786 / 67,099 |

Provider token accounting differs; cached context repeats across turns. These
numbers do not establish equal reasoning work or a subscription-dollar cost.
No dollar charge was reported by either subscription path.

The one-second native process-tree sampler observed average CPU 4.37/4.97% of
one core on OpenAI and 4.51/3.75% on Claude. Peak summed physical footprint was
400/403 MiB versus 497/752 MiB. Host peak RSS, a different measure, was 694/684 MiB
versus 679/614 MiB. Maximum host timer delay was 273/307 ms versus 1148/393 ms.
The sampler misses startup CPU and short-lived descendants; summed footprints
can include shared pages. No long-session memory claim follows from these runs.

## Qualitative review and decision

A single, non-blinded review inspected all 57 generated assertions, checked key
claims against cited source passages, and compared coverage and admission choices.
This is a spot grounding/coverage review, not an independent scored evaluation.

- Every run covered the six substantive intake arrivals. The sampled dates,
  technical results and commitments checked out against the cited text.
- All runs preserved source attribution and distinguished a user's request from
  proof of its completion. No unsupported completion claim was found.
- OpenAI produced compact content assertions and fewer capture-history facts.
  Claude included more technical detail and additional clipping-history context.
- Claude linked 19/16 distinct entities versus OpenAI's 8/9. That may improve
  later entity-specific retrieval; speed and assertion count alone do not measure
  that benefit. OpenAI's links varied between repetitions even with equal counts.
- Both OpenAI runs and one Claude run passed both staged promotional/onboarding
  messages. The other Claude run admitted the onboarding message and recorded
  account signup as a candidate. This is a relevance/recall tradeoff, not a failed
  queue drain or established hallucination.

The repeat speed advantage, successful completion, concise output and absence of
observed major grounding failures support a **provisional gardener preference**
for OpenAI. Claude remains useful when richer entity linking/detail matters.
A larger multi-cohort retrieval evaluation could reverse this recommendation.
Nothing here ranks providers for memory, Quick or Pilot; those roles are unchanged.

## Configuration behavior

`lib/model-defaults.yaml` owns the gardener provider order and each provider's
model/reasoning defaults. The catalog endpoint offers the first ready provider's
recommendation, falling back to Claude when only Claude is connected. Settings'
existing **Use recommended settings** action now uses that cross-provider choice.
It applies on explicit selection; existing saved choices are not silently migrated
on login, catalog refresh or dispatch. Connecting ChatGPT after Claude also now
preserves per-role selections when no legacy `curation` block exists.

## Reproduction

Keep one unprocessed marked fixture prepared by `profileGardener.ts`. For each run:

```
bun test/support/profileGardener.ts clone <baseline> openai
# or: clone <baseline> anthropic
bun test/support/profileGardener.ts run <new-clone> --live
```

Cloning refuses unmarked, symlinked or already-processed baselines. The OpenAI
preflight requires an available model on a connected ChatGPT subscription; it
does not silently switch to API billing. Use fresh clones for every repetition.
