# Assertion intake agent — staging shadow

> **HISTORICAL (2026-08-30, #644).** The shadow ran and won: assertion intake is the live path and the editor queue is retired (#498). Kept as the design record.

Status: experimental. This path does not replace or settle the existing editor
queue, does not build dossiers, and is not enabled by a hosted service.

2026-08-21: the Codex/ChatGPT-subscription harness below is RETIRED. The
runner is now the pi loop on the Anthropic API (`lib/assertionPiCall.ts`),
Opus by default — decided after the staging canary measurements (#421): the
subscription harness could never run hosted (no credential on any box), and
the canary's real extraction already ran over the Anthropic API. The model
keeps the same bounded read surface, now as in-process tools (no shell, no
subprocess, no sandbox to configure), and delivers proposals through a
schema-typed `submit` tool instead of final-text JSON. Dollars are journaled
per run (`usage.cost_usd`), so intake COGS is measurable without inference.
The measured tables below are kept as history; model alternatives get
benchmarked against the run journals and the retrieval ledger before any
change from Opus.

## Flow

1. Intake appends `source.inserted` and adds the insertion id to the existing
   arrival queue message (the compatibility reference id remains in `refs`).
2. `bigbrain assertion-agent --queue` reads, but never claims or mutates, that
   durable queue history and selects up to eight arrivals not named by a prior
   successful assertion-agent run.
3. A host-side pi session on the Anthropic API reads sources and prior
   context through in-process, read-only projection tools (source / search /
   entity).
4. The model submits natural-language assertion proposals through a
   schema-typed `submit` tool. It may suggest `[[new entity]]` or reuse a
   searched `[[ent_<id>|display]]`; it never writes the vault.
5. Host code canonicalizes entity links, resolves source insertion identities,
   appends `assertion.asserted`, incrementally updates the
   disposable SQLite/FTS projection, and records model/thread/token metadata in
   `journal/assertions/`.
6. A model-call, proposal, or append failure writes an immutable
   `assertion.intake_rejected` record to that journal. The record carries its
   source ids, failure stage, model invocation, usage, diagnostics, and output
   digest. It is process evidence—not an assertion—and therefore neither enters
   the graph nor marks a source handled. A retry produces a separate record.

Relationships remain prose. There is no predicate ontology and no special
`met`, `works_on`, or social-edge mechanism. “Alex spoke with Morgan about
table formats” is useful because those words and entity links are indexed,
not because they populate a privileged edge type.

When this substrate is present, the home feed and graph both project from the
native insertion/assertion logs. A source node opens a deterministic rendering
of its immutable insertion event. `references/` remains a tolerated legacy
projection, but it neither supplies the assertion graph nor the feed, so the UI
cannot combine a new graph with an unrelated old file list.

## Containment

- The model has no shell, no filesystem tools, and no network tools: its
  only capabilities are the four registered in-process tools, and three of
  them are read-only prepared statements over the projection. Nothing the
  model sends is executed — arguments ride as bound SQL parameters or
  character offsets, never as a path or a command.
- Projection readers open SQLite read-only; schema/WAL writes happen before the
  model starts.
- The model's final output is data. Host validation is deterministic: schema
  and size bounds, source existence, authorship, wikilinks, and event identity.
  It makes no second model call and does not judge a claim's truth or support.
- Invalid assertion proposals are recorded in the successful run journal and
  discarded independently; they do not erase valid assertions from the batch.
- Rejected generated prose is retained only by SHA-256 digest. This attributes
  an attempt without letting unsupported text masquerade as vault knowledge.
- Hosted boxes never carried a ChatGPT credential; the pi runner instead
  uses a spend-capped Anthropic key of the same kind the warden already
  supplies to the editor and memory passes, held in process memory only.

## First measured run (2026-08-18)

Model: `gpt-5.6-sol`, medium reasoning, ChatGPT subscription. Corpus: isolated
clone of staging with 679 source insertions. No production access or mutation.

| Input | Wall time | Input tokens | Cached input | Output | Result |
|---|---:|---:|---:|---:|---|
| 37.7k-character meeting | 61.9 s | 103,628 | 76,800 | 2,754 | 7 assertions |
| 2.6k-character finding | 43.0 s | 44,738 | 28,160 | 1,894 | 6 assertions |
| two-item batch: 2.2k finding + 746-character `/clear` transcript | 58.8 s | 85,518 | 62,464 | 2,108 | 3 + 0 assertions |

The assertions were substantively useful and entity reuse worked: the second
and third runs reused existing person and organization IDs; a query for a
participant and topic retrieved the meeting assertion. The economic warning is
equally clear: the Codex harness has roughly 45k input tokens of fixed/session
overhead, and tool turns can double that. Batching is therefore a requirement,
not an optimization. Subscription execution has zero marginal API charge but
does consume plan capacity; the run journal records tokens because dollars
cannot be inferred from a subscription run.

## Commands

Explicit isolated items:

```sh
bigbrain assertion-agent \
  --insertion ins_... --insertion ins_... \
  --owner-label "Alex Rowan" --json
```

Oldest unprocessed native arrivals from queue history (maximum eight):

```sh
bigbrain assertion-agent --queue --limit 8 --owner-label "Alex Rowan" --json
```

Scheduled (2026-08-22, #475): the hosted warden runs the intake pass itself —
`bun bin/assertion.ts`, one bounded batch of ≤8 per invocation — for every
ACTIVE tenant whose vault.yaml says `assertions: { native: true }`, on the
same 5-minute tick as the memory pass, re-signaling while a run makes
progress so a burst drains batch by batch. Owner labels come from the record
(the identity declaration, plus `BIGBRAIN_OWNER_EMAIL` when set) rather
than a flag. Spend and failures are metered from `journal/assertions/<month>/`
into the registry under pass `assertion` (`telemetry models` shows `$/ref` as
$ per arrival handled), and a rejected batch counts toward the tenant's
circuit breaker like any failed run. Both doors take the same per-vault lock
(`.state/assertion.lock`), so an operator run beside a tick waits rather
than double-extracting. Retry policy is still "every tick until the breaker
trips" — a persistently rejected batch is bounded by the three-strike
breaker, not by a per-insertion attempt count.

## Source-reference model comparison (2026-08-18)

The v2 contract removed quote reproduction entirely. The model emits assertion
prose, entity wikilinks, and insertion ids; deterministic host code resolves
those ids. Six identical sources (two findings, one web clip, one note, and two
agent chats; about 12k characters total) were run against isolated copies of
the same prior projection. An initial Luna run exposed an ambiguous shell-pipe
example in the tool instructions; that prompt was fixed and the biased run was
discarded before comparing the three corrected arms.

| Model | Wall time | Input (cached) | Output | Assertions | Sources represented | Host rejects |
|---|---:|---:|---:|---:|---:|---:|
| `gpt-5.6-luna` | 66.2 s | 96,501 (72,704) | 2,998 | 10 | 5/6 | 0 |
| `gpt-5.6-terra` | 67.7 s | 108,920 (79,872) | 2,657 | 5 | 4/6 | 0 |
| `gpt-5.6-sol` | 68.1 s | 82,557 (56,576) | 2,814 | 9 | 4/6 | 0 |

This small run shows that the simpler contract does unlock the lower tier
mechanically: Luna completed cleanly and had the broadest lexical retrieval
coverage. It is not yet evidence that Luna should be the default. Its extra
assertions included more entity-label fragmentation (for example, creating a
new `Claude Opus 5` entity beside an existing `Opus 5` entity). Sol remained
more precise about operational state, while Terra was terse enough to omit a
substantive Anthropic finding. Model choice therefore needs a larger blind
retrieval evaluation; schema acceptance alone is no longer the limiting gate.
