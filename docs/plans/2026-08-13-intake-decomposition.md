# Intake decomposition: staged pipeline, per-job models

> **RETIRED (2026-08-30, #644).** The staged pipeline proposed here was built as the editor's pre-passes and retired with the editor pass (#498); hosted-era code at tag `hosted-multitenant-final`.

*2026-08-13. Status: proposed. Grounded in the intake-bench results
(`~/Projects/intake-bench` on Nick's laptop; report:
https://claude.ai/code/artifact/70366ad5-39b3-4994-aea1-bea33ef799cb).
Governing principles: [docs/design-principles.md](../design-principles.md) —
especially "lifecycle owned by code" and "the engine sorts". Related rulings:
#287 (sonnet editor observation, decide by 2026-08-20), #286 (request siphon
stays for now), #68 (outcome-contract hole), #177 (retrieval-grounded
quality).*

## Why

The editor today is ONE frontier-model invocation per execution that does
seven duties — extraction, salience, categorize, resolve, absorb-or-decline,
place, and write. Measured from the live vault's `journal/queue`, that
monolith costs a median **$0.187 and 82 s per item** (p90 $0.32 / 216 s).

Benching each duty separately against the vault's own settled outcomes shows
the jobs split cleanly by kind:

| job | best mechanism | fidelity vs incumbent | $/item |
|---|---|---|---|
| categorize | haiku, batched (door default alone: .931) | .987 | $0.0008 |
| resolve | alias/fuzzy matcher; haiku only on its ambiguous residue | .981 | ~$0.0001 |
| absorb-vs-decline | opus, batched classifier | .903 | $0.005 |
| place (target dossiers) | sonnet from generated candidates | .717 (ceiling .85) | $0.022 |

Two structural facts follow. **Deterministic code wins wherever the door
already knows** — models add value only in small residues. And **editorial
judgment is real but narrow**: the decline boundary needs opus (haiku and
sonnet over-decline 3×), placement saturates at sonnet, and only the WRITE —
composing dossier edits — still needs the full harness.

## Target shape

Intake becomes a staged pipeline. Stages 1–4 are code plus batched
classifier calls that return verdicts as data; the harness survives only as
stage 5. Every lifecycle move stays runner-owned; no model ever moves a
message.

```
1 LAND      deterministic (exists): envelope, dedup, category stamp, enqueue
2 RESOLVE   code: alias/fuzzy match over entities/ index
            → haiku tiebreak ONLY where the matcher says ambiguous/none
3 JUDGE     opus, batched over full item text:
            absorbed | declined(reason)  [+ category confirm, ~free]
            → declined messages settle in queue/done WITHOUT a harness run
4 PLACE     candidate gen (lexical now, embeddings next) → sonnet picks
            target dossiers per item
5 WRITE     the harness (pi), fed stages 2–4 as runner facts:
            compose dossier edits, mechanical verification unchanged
```

Stage outputs ride on the message as **runner-computed facts** — the same
`facts` channel repairs already use ("mechanisms write refs and facts").
Each stage execution journals like any model invocation (model, prompt sha,
usage, wallMs), keeping the replay ledger whole: replay re-runs stages the
same way it re-runs executions today.

### What each stage changes in code

**Stage 2 — resolve.** `lib/editor/resolve.ts` already builds the alias-aware
lookup the model calls as a tool. Lift it into a pre-pass: extract candidate
mentions (capitalized spans + attendee fields, cheap and recall-oriented),
match against the alias index, and write
`facts.entities = {mention → path | ambiguous | none}`. Mentions the matcher
flags go to haiku in one batched call. Bench: this router beats every
single-engine configuration (.981), touching a model for ~5% of mentions.

**Stage 3 — judge.** One batched opus call per drain (≤25 items), full item
text, closed output grammar: `absorbed | declined: <reason>`, plus a category
confirm at ~zero marginal tokens (haiku benched .987 standalone; folding it
into this call removes a moving part — verify equivalence in shadow).
Declined items: the runner writes the outcome and moves the message to
`done/` itself — the item never spawns a harness run. Declines are cheap to
reverse (the reference is landed and searchable regardless; `bigbrain queue
add` re-enqueues), and the queue screen already shows declines with reasons.
Bench: .903 agreement, absorbed-recall .917, declined-recall .833 — and the
benched figure is a floor, since it ran on truncated text.

**Stage 4 — place.** Candidate generation in code (alias/token overlap over
the full item text — benched ceiling .85), sonnet picks targets in one
batched call → `facts.targets = [entities/…]`. Bench: .717 any-target
agreement, opus no better. Follow-up lever is embeddings-based candidates —
the engine already runs voyage embeddings for `{{candidates}}` — to lift the
ceiling; that is an issue of its own, not this refactor.

**Stage 5 — write.** The pi invocation keeps duties 0 (extraction), 3-as-
editing (fold facts into dossiers), 6 (tend), 7 (report), and receives
stages 2–4 as a runner-facts block: resolved entities with their dossier
paths, judged set (absorbed only), chosen targets. The prompt loses the
resolve tool round-trips, the decline decision, and the categorize duty —
fewer turns, smaller context, and the failure mode #287 flagged (sonnet
editor "refs not filed" retry loops) loses its main source of drift, since
the write step no longer owns the absorb/decline call. Verification stays
exactly the mechanical diff scan (`sources:` + wikilink), and outcome
grammar in `queue/done` is unchanged.

**Model calls for stages 2–4** go through the ModelRuntime path piRun
already uses (per-tenant spend-capped keys, host-side), not `claude -p` —
no container needed for classifier calls, and prompt caching applies. The
`claude-cli` engine keeps working: stages degrade to the same runtime.

### Configuration (additive, tolerant-read — principle §5)

```yaml
queue:
  model: …             # stage-5 writer, as today
  stages:              # NEW, optional; absent = monolith behavior unchanged
    resolve: claude-haiku-4-5
    judge:   claude-opus-5
    place:   claude-sonnet-5
```

A vault.yaml without `stages:` runs today's path byte-for-byte. Flags flip
per stage (below), so there is no cutover day and no migration.

## Cost and latency model

Per 100 arrivals at live-vault mix (17% declined):

| | today (opus writer) | staged, opus writer | staged, sonnet writer |
|---|---|---|---|
| stages 2–4 | — | ≈ $2.80 | ≈ $2.80 |
| write | 100 × $0.187 = $18.70 | 83 × ~$0.09 ≈ $7.50 | 83 × ~$0.03 ≈ $2.50 |
| **total** | **$18.70** | **≈ $10.30 (−45%)** | **≈ $5.30 (−72%)** |

Write-stage estimates assume the slimmed prompt cuts the harness run
roughly in half (fewer tool turns; resolve round-trips gone) — to be
measured in shadow, not assumed. Latency: declined items settle in ~2 s
instead of ~82 s; absorbed items ride one batched judge/place wave
(seconds) plus a shorter write run. Target: **≥2× cheaper and ≥2× faster
median per item at fidelity ≥ bench** before any flag flips; the sonnet-
writer column is the #287 decision, which this refactor de-risks by moving
decline judgment out of the writer.

## Verification and rollout

**What the gates measure: bias, not agreement (ruled 2026-08-13).** Much of
intake is legitimately non-deterministic — #177's pilot ran the incumbent
against itself and got entity-set exact-match 0%, and in intake-bench every
engine's exact-set score on place clustered near .2 while core-target
agreement ran 3× higher. There is a stable CORE the runs converge on and a
periphery where the incumbent itself is a coin flip; replicating a coin flip
is not a goal, and exact-agreement gates would be measuring noise. The
distinction that matters is **variance vs bias**: peripheral flicker is
harmless (and cheap to accept, because the lake is add-only, declines are
one `queue add` from reversal, and the vault is a re-derivable view — YOLO
on this ledger is re-runnable spend, not damage); systematic skew compounds
(haiku's 3× over-decline was not noise, it was drift). Gates therefore
bound bias and protect the core, and drop exact-set agreement everywhere:

- **resolve ≥ .98** — identity is the non-YOLO stratum: right answers
  exist, forks contaminate later absorptions, and .98 is achievable.
- **judge**: decline RATE inside the incumbent's band (~10–25%) AND
  absorbed-recall ≥ .90. Raw agreement is a sanity floor, not a gate.
- **place**: core-target recall ≥ .70 (any-hit) plus the #177 retrieval
  eval. Exact dossier sets are periphery; not gated.
- Disagreements with the incumbent are adjudicated by "does retrieval
  change?", never by "who matched the label" — under non-determinism that
  is the only coherent quality question.

Where either answer is defensible, prefer the deterministic tie-break
(matcher, category census) over re-rolling a model: arbitrary-but-stable
beats arbitrary-and-flickering for the reader.

**intake-bench is the acceptance harness.** The gold builders and per-stage
benches move into `tools/bench/` beside the #173 replay harness, scoring
the gates above as regression checks. Quality beyond replication stays
retrieval-grounded per #177 — run the retrieval eval before and after the
write-prompt slim.

**Shadow before flip, per stage.** Each stage ships computing verdicts and
journaling them WITHOUT acting — the monolith keeps deciding. Shadow is not
accuracy validation against ground truth (mostly there isn't any); it is
three things: **cost and speed measurement**, **bias detection** (rates and
directions need no gold at all), and a **human glance surface** — a decline
digest Nick can skim. Staging first, then the live vault (shadow is
read-only + one journal write, safe under the prod freeze; flag flips on
prod wait for the post-alpha-refactor milestone to close, per the standing
rule). Flip the flag when the bias bounds hold for a week of real arrivals.

**Flip order = payoff order:**

1. **Judge gate** (biggest, simplest win: 17% of items stop paying $0.187
   and 82 s; the DLQ pressure from junk drops too).
2. **Resolve facts** into the write prompt (kills resolve tool round-trips;
   also fixes the fork-a-dossier failure class at its source).
3. **Place facts** + write-prompt slim (the prompt change is the risky one —
   A/B via replay-from-git before shipping; vault-local prompts win by
   design, so the live vault's prompt updates as its own deploy step).
4. **Writer model decision** (#287): with decline judgment removed from the
   writer, re-run the sonnet observation; flip `queue.model` if the
   retrieval eval holds.

Incidental fixes that belong to this refactor because the seams open anyway:
**claim-per-execution** (stages make "running = a model is on it" natural —
claim at stage entry, not drain start), and **#68** (the outcome contract
gains `already-current` as a terminal success, closing the DLQ-despite-
correct-work hole).

## Risks

- **Silent false declines.** A wrong decline hides an item from dossiers
  (never from the lake — feed/search unaffected). Mitigations: shadow week,
  absorbed-recall gate at .90+, decline reasons on the queue screen, and
  declines stay one `queue add` from a retry.
- **Stage sprawl.** Five stages could ossify into five prompts to maintain.
  Containment: stages 2–4 are one prompt each with closed output grammars,
  versioned like the editor prompt; no stage may gain free-text instructions
  (principle §2 holds — verdicts are data).
- **Bench circularity.** Gold labels are the incumbent's outputs; a staged
  pipeline that beats the incumbent will *disagree* with it — and under the
  variance/bias frame above, peripheral disagreement is expected and free.
  The gates are floors for flipping flags, not ceilings — disputed cases go
  to the retrieval eval, and the person-directive ledger (53 and growing)
  remains the only human gold.
- **Batching vs. debounce.** Judge/place batch across a drain; a single
  trickling arrival still pays one small batched call. Acceptable — the
  debounce already shapes arrivals into batches.

## Work breakdown (issues to file on acceptance)

1. Stage scaffolding: `lib/editor/stages.ts`, `stages:` config, per-stage
   journal records, shadow mode. (M)
2. Resolve pre-pass: mention extraction + matcher + haiku residue;
   `facts.entities`. (M)
3. Judge stage: batched opus classifier + decline settlement by runner;
   category confirm folded in; decline digest surface. (M)
4. Place stage: candidate gen + sonnet targets; `facts.targets`. (S)
5. Write-prompt slim + facts block render; replay A/B; prompt-contract
   version bump. (M, riskiest)
6. Bench-as-gate: port intake-bench gold builders into `tools/bench/`,
   wire thresholds. (S)
7. Embeddings candidate gen for place (post-flip follow-up). (M)
8. Claim-per-execution + #68 `already-current` outcome. (S)
