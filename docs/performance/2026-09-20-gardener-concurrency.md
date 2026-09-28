# Two-session gardening — 2026-09-20

Issue #859. Two simultaneous sessions are a promising throughput improvement:
on this cohort, mean completion fell **41% for Claude** and **25% for OpenAI**.
Time to first filing did not improve materially. Keep production single-session
until related-arrival coordination and overlap handling are evaluated. The
prototype and measurements live under test support; no production behavior,
provider recommendation, permission, prompt or model default changes.

## Prototype

`test/support/concurrentGardener.ts` holds the existing gardener PID lock while
two normal `runAgent` calls execute. Their ordinary role-scoped tools and shared
validators remain in use. A benchmark-only wrapper around tool handlers:

- assigns the first three intake arrivals to session 0 and the next three to
  session 1; session 0 owns the staged arrivals;
- filters `next` to the assigned work and refuses cross-session filing/opening;
- serializes `next`, `open` and `submit`, assigning newly admitted insertion IDs
  to the admitting session before another session can pull work;
- allows shared context reads, but refuses claims citing another session's
  assigned arrivals; each assertion must cite at least one of its own arrivals;
- waits for both sessions to settle before restoring handlers and releasing the
  lock, even when one fails. Accepted events remain durable and unfinished work
  remains due. There is no persistent claim store or new durable queue.

AsyncLocalStorage identifies each session across the existing provider transports.
The prototype is restricted to a marked scratch fixture with at most eight initial
arrivals and 2–8 intake items. It refuses same-source jobs, revisions and attached
voice/about dependencies. These checks are structural, not proof of semantic
independence. There is no dynamic work stealing, production progress aggregation,
user cancellation integration or automatic retry of a failed sibling.

The wrapper asks the normal `next` handler for up to eight context packs before
filtering; that extra preparation is included in measured time. Baselines use
normal `runTend` with one round and memory excluded. Concurrent runs reuse its
prompt, owner labels, model settings, session adapters and tool handlers, but
use the benchmark coordinator instead of the production round journal/lifecycle.
Per-session usage is summed in the profiler's result. This measures the proposed
scheduling arrangement, not a production-ready deployment.

## Method

Engine baseline 6cc1ada; experiment implementation ab952fd. Eight fresh clones
of the same unprocessed cohort used in #842/#850: six intake arrivals and two
staged messages; prior record 3,448 sources, 4,905 assertions, 715 entities.
Each provider ran concurrency **1 / 2 / 2 / 1**, Claude first, then OpenAI.
No simultaneous benchmark runs except the two sessions within a concurrency-2
run. Normal engineering work continued, so native resource samples are
observational, not quiescent-machine measurements.

Claude used `opus` / default effort through Claude Code subscription; all SDK
transcripts identify `claude-opus-5`. OpenAI used GPT-6 Astra / medium through
Pi's connected ChatGPT subscription. No API billing fallback, memory pass,
original-vault writes or provider/model changes. The prompt was unchanged.
Each fresh replay removes prior claims for the selected arrivals but retains
other existing context, including related older sources. This is one small
cohort with model/provider variation, not an estimate for every vault.

## Results

| Run | Provider | Sessions | Complete | First claim | Claims | Rejected items | Admit / pass |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | Claude | 1 | 132.90 s | 67.80 s | 13 | 0 | 0 / 2 |
| 2 | Claude | 2 | 69.75 s | 52.91 s | 16 | 0 | 1 / 1 |
| 3 | Claude | 2 | 84.85 s | 70.35 s | 17 | 0 | 0 / 2 |
| 4 | Claude | 1 | 128.18 s | 55.97 s | 12 | 2 | 1 / 1 |
| 5 | OpenAI | 1 | 59.15 s | 27.86 s | 10 | 0 | 0 / 2 |
| 6 | OpenAI | 2 | 44.20 s | 31.67 s | 12 | 0 | 0 / 2 |
| 7 | OpenAI | 2 | 49.49 s | 31.79 s | 12 | 1 | 0 / 2 |
| 8 | OpenAI | 1 | 65.05 s | 31.62 s | 9 | 0 | 0 / 2 |

All runs drained both queues. Mean complete time was 130.54 → 77.30 seconds for
Claude and 62.10 → 46.84 seconds for OpenAI. Mean first filing was 61.89 → 61.63
seconds for Claude and 29.74 → 31.73 for OpenAI. First filing means the first
successful non-deduplicated assertion, not a pass or admission. Complete time
includes final responses and coordinator teardown.

The gain comes from overlapping sessions, not reducing the number of SDK-reported
turns: summed turns rose from 17 → 19 for Claude and 9.5 → 13.5 for OpenAI.
These counters are not directly comparable across providers. Transcripts show
two separate sessions for every concurrent run and no tool-level errors or
ownership-guard failures. The rejected OpenAI item was malformed new-entity link
syntax, corrected normally; the Claude baseline also needed entity corrections.
Outside-handler time includes generation, network/provider waits and runtime
work and must not all be labeled reasoning.

## Usage and native resources

These are mean reported tokens per complete run, summing both sessions when
concurrent. Subscription quotas need not charge each category equally; these
numbers are not dollar costs or guaranteed quota multipliers.

| Provider / sessions | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| Claude / 1 | 28 | 11,167.5 | 563,646 | 62,360.5 |
| Claude / 2 | 35 | 12,840 | 427,808 | 68,528.5 |
| OpenAI / 1 | 35,018 | 1,417 | 136,576 | 0 |
| OpenAI / 2 | 43,894 | 1,784.5 | 134,912 | 0 |

Claude output grew about 15%; OpenAI input and output grew about 25–26%.
Claude cache-read volume decreased, consistent with two shorter histories rather
than carrying both batches through one history; this is an interpretation, not
an isolated causal measurement. Concurrent outputs also selected more details.

Peak sampled summed process physical footprint was 436–479 MiB for single Claude
versus 522–669 MiB for concurrent Claude. OpenAI was 279–326 versus 284–313 MiB,
with no demonstrated increase in this small sample. A one-second process-tree
sampler misses short-lived peaks and may double-count shared pages. These are
not RSS measurements or evidence about long-session growth. Exact CPU/footprint
aggregates are in the companion JSON.

## Quality and limits

One nonblind reviewer read all **101 new claims**, compared source coverage,
entity choices, dates/commitments, attribution and request-versus-completion
handling, and spot-checked detailed technical/numeric statements against the
source passages. All six intake sources were represented in every run. The
review found no fabricated completion of a user request, and no exact duplicate
claim text after normalizing entity-link display and whitespace. This is not a
blinded retrieval evaluation, and absence of exact duplicates does not establish
absence of semantic overlap.

There were meaningful differences. One concurrent Claude run filed only the
recapture history of a previously saved essay, while the other runs also filed
its substantive argument. Older relevant context was already retained in the
fixture, so this is not evidence that the entire vault lost that information;
it does show source-count coverage is too weak a quality metric. That same run
made a candidate contextual connection citing the current source but omitted
the older source supporting its dated contextual premise. Other runs cited both.
This is a citation-completeness concern, not proof of a concurrency-specific
cause. Concurrent Claude tended to record more technical and capture metadata;
OpenAI's parallel outputs retained comparable main facts with more detail.

A separate synthetic test deliberately puts the same fact in two assigned
arrivals. Both sessions can file equivalent text with different evidence sets;
the normal idempotency key correctly does not merge distinct submissions.
Serialized writes prevent concurrent mutation, but do not perform semantic
deduplication. Another test confirms that two sessions naming the same canonical
new entity resolve to one entity through the existing validators. Neither test
establishes safe resolution of ambiguous aliases or related real-world arrivals.

## Decision and next gate

Production hardening is tracked in #860.

Keep this as an opt-in **benchmark flag only**, not a product setting. The observed
throughput gain merits further work. Before production rollout, evaluate related
arrivals, overlapping facts and ambiguous identities; define a conservative
serial fallback; integrate cancellation, rate-limit handling, retry accounting,
and combined progress/usage into the normal single gardener lifecycle. Keep
memory after coordinated intake completion. Preserve the shared tool surface
and existing validation rather than adding provider-specific filing paths.

## Reproduction and validation

```
bun test/support/profileGardener.ts clone <marked-unprocessed-snapshot> anthropic
bun test/support/profileGardener.ts run <fresh-clone> --live --concurrency=2
```

Use `openai` for the other provider and omit the concurrency flag for the normal
single-session control. Always clone again for each run. Guard tests cover
unique assignment, serialized writes, admitted ownership, cross-session refusal,
shared entity validation, sibling failure/lock lifetime, related-arrival refusal,
and the semantic-duplication limitation. Raw sources, identifiers, searches,
claims and transcripts stay private; only aggregate measurements are committed.

Validation: 1,987 tests passed, 3 skipped, 0 failed; engine typecheck and lint
passed. Aggregate checks verified eight drained runs, both session identities in
each concurrent trace, no tool-level errors, complete source-count coverage and
101 reviewed claims.
