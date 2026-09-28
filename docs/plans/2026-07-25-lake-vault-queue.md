# Refactor: lake / vault / queue

> **HISTORY (2026-08-31, #510).** Status was "proposed" for five weeks
> after the plan shipped. It is DONE in substance and superseded in
> detail: the lake is `log/insertions/`, the vault is the projections
> over it, and there is no queue at all — work is a view
> (`docs/design-principles.md` §2, rewritten to say so). The
> live-vault migration section below was abandoned on 2026-08-02 and
> says so at its own head. Read this for the reasoning; read
> `design-principles.md` for what holds today.

*2026-07-25. Governing principles:
[docs/design-principles.md](../design-principles.md). Open issues:
[#1 dedup](https://github.com/elsehow/BigBrain/issues/1),
[#2 redaction](https://github.com/elsehow/BigBrain/issues/2). Phases
tracked as
[#3](https://github.com/elsehow/BigBrain/issues/3) (seams),
[#4](https://github.com/elsehow/BigBrain/issues/4) (lake),
[#5](https://github.com/elsehow/BigBrain/issues/5) (queue),
[#6](https://github.com/elsehow/BigBrain/issues/6) (derived view),
[#7](https://github.com/elsehow/BigBrain/issues/7) (surfaces). UI
north star: the BigBrain desktop mockup (claude.ai/design project
the historical mockup component specifications).*

## Target shape

Three planes, replacing today's inbox → (triage/deep) → domains+library
flow:

- **Lake** — add-only, committed store of every item that enters the
  system. Written by intake code only, never by a model. Items are
  immediately indexed, immediately visible in the feed, immediately
  discussable. Integrations deliver the discussable version (principle
  §3); intake's job is landing + envelope + commit, no LLM anywhere.
- **Queue** — one typed work queue replacing both "inbox arrival
  triggers triage" and `requests/`. Messages are verb + lake refs +
  capability level + params (principle §2). Lifecycle
  (pending→running→done/failed) is moved by **code**, never by the
  model. History is retained forever; every execution is journaled with
  its full invocation (principle §1).
- **Vault** — `domains/` (+ entities), model-written as today, but now
  a **pure derived view**: every note cites the lake items it draws on,
  and deleting the vault + replaying the queue would rebuild it in
  spirit (principle §1).

What the mockup adds on top: a unified recent feed (lake, with a
"filing…" state until the first `file` execution lands), a visible work
queue with capability chips, per-note "touched by" provenance, and
entities as first-class notes. All of that becomes derivable once the
three planes exist.

## Current → target map

| Today | Target | Change |
|---|---|---|
| `inbox/` (gitignored, transient, invisible until filed) | `lake/` (committed, permanent, visible at once) | new plane |
| `requests/` + inbox-arrival-as-trigger | `queue/` (typed messages) | unify + type |
| `library/` (model-curated "raw" tree) | frozen legacy tree; new raw content lands in the lake | writer changes: code, not model |
| `domains/` | unchanged shape; gains citation discipline | contract |
| triage pass / deep pass | one worker, two lanes (fast: low+med, slow: high) | reframe, same launchd shape |
| journal: model name only | full invocation record per message | principle §1 |
| `inbox/unsorted/` | `queue/failed/` (a real DLQ) | rename + semantics |

## Phase 0 — seams (pure refactor, no behavior change)

The two changes that unlock everything else; ship first, separately.

1. **Typed envelope.** `lib/envelope.ts`: parse/serialize item
   frontmatter once with the `yaml` lib, exporting the shared
   `Envelope` type (`id, source, kind, title, date, aliases, from,
   from_kind, submitted_by, submitted_via, received, sha256, …`).
   Replace the ~8 ad-hoc regex parsers (`bin/editor.ts:186`,
   `web/server.ts:147 isDeepRequest`, `noteId()`, `fmProvenance()`,
   `noteWhen()`, …) site by site. Must be side-effect-free (no
   `manifest.ts` import — same dodge as `embedcfg.ts`/`engine.ts`).
2. **Make the editor importable.** Split `bin/editor.ts` (546 lines,
   zero exports, zero tests) into `lib/editor/workload.ts` (what work
   exists), `lib/editor/run.ts` (invoke the model), and
   `lib/editor/record.ts` (journal + stamps + commit), with
   `bin/editor.ts` reduced to a thin script. Add
   `test/editor.test.ts` against fixture vaults. `detectMoves()`,
   `siphonRequests()`, prompt building, and the lock all become
   testable.

Exit criteria: identical behavior on the sandbox vault (/verify skill),
existing 7 test files still green, new editor tests cover
workload-selection and move-detection.

## Phase 1 — the lake (additive; old flow keeps running)

**Layout.** `lake/YYYY/MM/<id>.md` — envelope frontmatter +
discussable text, committed, author `intake`. Raw payloads
(attachments, original bytes) do **not** ride in git: they live in the
blob store (below), and the envelope references them by hash
(`attachments: [{name, sha256, bytes, mime}]`). The write-guard hook
extends to deny interactive writes to `lake/`.

**Landing.** `receiveItem()` (`lib/intake.ts:69`) writes the lake item
*first*, then (during transition) the inbox copy. Intake stamps
`sha256` of the discussable content; `id` is required (already
generated when absent). Exact-dupe short-circuit: same `sha256` seen
before → no new item, return the existing id (near-dupes stay issue
#1). The ssh path (`bin/receive.ts`) starts stamping ids too — today it
stamps nothing, which breaks identity downstream.

**Immutability with real semantics.** Nothing ever edits a lake item.
Filing facts do NOT get stamped onto it (today's `filed`/`triage_run`
stamps die): the lake item is cited *by* vault notes, and "where did
this get filed" is derived by joining lake id → citing notes via the
index. This is what keeps the plane genuinely add-only. `redact` is the
reserved sanctioned exception (#2).

**Visibility.** `lib/search.ts` corpus grows from `domains/ + library/`
to include `lake/`. `/api/recent` reads the lake by `received` date
directly (replacing the `git log --name-status` reconstruction at
`web/server.ts:220`). Feed rows with no citing note and a pending
`file` message render as "filing…" — the mockup's unfiled state.

**Payload store (decided 2026-08-02): a private CAS — not git, not
IPFS.** Canonical store on the host at
`<vault>/.blobs/sha256/<ab>/<hash>` (gitignored; truth on the host,
covered by the host's file backup rather than git). `lib/blobs.ts`
owns write/read/delete; the intake API grows `PUT /v1/blob` (server
computes and returns the sha256; scope `inbox:write`),
`GET /v1/blob/<sha256>` (`vault:read`), and `DELETE /v1/blob/<sha256>`
(person-only — the redaction path, #2). `receiveItem()` writes
attachments to the CAS instead of `<dest>/attachments/`; the viewer's
`/api/file` resolves blob refs; a mirror fetches blobs lazily over the
API and caches them in the same layout (host canonical, mirror cache).
Content addressing gives exact-dedup for free (#1) and makes deletion
a real filesystem delete plus a lake tombstone (#2). sha256 keys
translate cleanly to CIDs if a distributed store is ever warranted —
the envelope contract never changes. (IPFS itself was considered and
rejected: unpin/GC semantics and DHT exposure are hostile to provable
redaction, and this system has exactly two trusted replicas with an
authenticated transport already.)

Exit criteria: a `bigbrain drop` is visible in `bigbrain search` and
the feed within seconds, before any model runs; killing the editor
entirely does not hide new content.

## Phase 2 — the queue (the big one)

**Format.** `queue/pending/<id>.yaml`, moved by the runner through
`queue/running/` → `queue/done/` or `queue/failed/`. Pure-YAML typed
message, not markdown prose:

```yaml
id: q-2026-07-25-abc123
verb: file            # closed, versioned set
refs: [granola-8f42]  # lake ids (or vault paths for maintenance verbs)
capability: low       # low | med | high
params: {}            # per-verb schema, validated on enqueue
from: granola         # principal (from/via rules per agent-interop doc)
via: integration
enqueued: 2026-07-25T13:04:00Z
```

**Verb set v1** (each grounded in an existing behavior):

| verb | replaces | default cap | authz |
|---|---|---|---|
| `file` | inbox triage of one item | low | any authenticated |
| `link` | link pass / `{{candidates}}` | med | any |
| `synthesize` | deep "find the spine" work | high | person or agent |
| `maintain` | vault-clean nightly | high | engine, person |
| `refile` | `writeRefileRequest()` config flow | med | engine, person |
| `redact` | — (reserved, #2) | — | **person only** |

There is deliberately no `ask`/question verb: BigBrain ingests and
sorts; it does not answer questions (principle §4 — bring your own
model; the discuss loop and agent interop are the Q&A surface). So no
verb takes free-text instructions from any principal: text riding in a
message or a lake item is data, never instructions. Any execution may
**escalate** by
enqueueing a new message at higher capability (today's deep-deferral
pattern, now typed).

**Lifecycle owned by code.** The runner moves message files; the model
never touches `queue/`. This replaces "move it to requests/done/" as a
prompt instruction — the single biggest transfer of queue semantics
from prompts into code (kills code-health pain #4). Crash recovery:
stale `queue/running/` entries whose runner pid is dead are reclaimed
to `pending/`, same pattern as the editor lock. Repeated failure →
`queue/failed/` with the error attached: the real DLQ
(`inbox/unsorted/` retires).

**Capability → model map** in `vault.yaml`, replacing per-pass models:

```yaml
queue:
  capabilities:
    low:  { model: claude-haiku-4-5, auth: max }
    med:  { model: claude-sonnet-5,  auth: max }
    high: { model: claude-opus-4-8,  auth: max }
  lanes:
    fast: { capabilities: [low, med], debounce: 5m }
    slow: { capabilities: [high],     debounce: 30m }
```

"One editor, two passes" becomes "one worker, two lanes" — the two
launchd entries survive unchanged, so ops shape and the
lock/debounce/stamp machinery carry over. The slow lane keeps deep's
drain-to-empty contract, now enforceable in code (a lane runs until its
capability set is drained).

**Journal per execution** (principle §1 — the current journal records
the model name and nothing else): message id + verb, model, auth mode,
prompt template sha256, disallowed-tools set, engine commit, embedding
provider/model behind any candidates, the candidate list, wall time,
the `runId`↔vault-commit binding, and the model's report. Honest
limitation, stated in the doc and the journal: `claude -p` exposes no
temperature control, so sampling settings are recorded as
"CLI defaults" — attributability, not bit-reproducibility.

**Prompts shrink to judgment.** With lifecycle, routing, and workload
selection in code, per-verb prompt templates (`prompts/file.md`,
`prompts/synthesize.md`, …) carry only *how to judge*, not queue
mechanics. Engine ships a prompt-contract version; `bigbrain install`
warns when a vault's prompts predate it (the `{{candidates}}` rollout
pain, systematized).

**Compatibility shims** (one release): `kind: request` inbox items are
converted to the closest structured verb (`synthesize` / `refile` /
`maintain`) at siphon time — one that fits no verb parks in
`queue/failed/` for the user to restate; `pass: deep` maps to
`capability: high`; existing `requests/*.md` on the live vault are
converted once by `bigbrain migrate queue` (originals to
`requests/done/` for the record). The editor's answer-emailed-questions
behavior retires with this (principle §4): email arrivals are ingested
and filed like any other item, and `emailReceipts()` acknowledgment
receipts are all that goes back out.

Exit criteria: an item dropped while the worker is stopped shows in
feed+search (lake) with a pending `file` message visible in the queue
UI/CLI; starting the worker drains it; `journal/` shows the full
invocation; nothing writes `requests/` anymore.

**CORRECTION (2026-08-02, by user ruling): there are no lanes.** The
fast/slow lane split this section sketched (`queue.lanes`, two
launchd/systemd jobs, triage/deep commit personas) was implemented and
then removed: ONE work queue, ONE worker, ONE scheduled job
(com.s-tier.editor / bigbrain-editor.service), and a message's
`capability` selects model configuration ONLY — it is never a scheduling
class. `queue.debounce` is the single cadence (legacy fallback:
`triage.debounce`); `queue.lanes` in a vault.yaml is accepted and ignored
with a warning. New machine commits are authored `editor`; the recorded
`triage`/`deep` history stays recognized everywhere it is read. The
queue-depth health verdict (`queueHealth`) was lane-relative and went
with the split.

## Phase 3 — vault as derived view

- **Citation contract.** Vault notes carry `sources: [<lake-id>, …]`
  frontmatter (machine-checkable; inline `[[…]]` links stay for prose).
  `bin/links.ts check` learns to verify every `sources` ref resolves to
  a lake item, and the `file`/`synthesize` prompts require citing the
  refs they were handed. Runner-side check: an execution that created
  vault notes with no `sources` fails loudly in the journal.
- **Entities.** Promote the `library/entities/` convention into the
  vault with typed frontmatter (`kind: entity`, `entity_type: person |
  place | document | thread`, `aliases`). No extraction pipeline yet —
  the `link`/`synthesize` verbs maintain them as they already do by
  convention; the engine merely *recognizes* them (graph API, feed
  chips, FTS boost). Matches the mockup's entity·person / place /
  document / thread chips.
- **Grandfathering.** Existing `domains/` notes lack citations and
  `library/` is not a lake. Forward-only discipline: new/edited notes
  must cite; a low-priority `maintain` variant opportunistically
  backfills `sources` on notes it touches. `library/` freezes — still
  readable, still linkable, never written again; no wholesale backfill
  into the lake (curated artifacts are not raw sources; pretending
  otherwise poisons the plane).

## Phase 4 — surfaces (the mockup, incrementally)

Ordered by pain: (1) queue view — `/api/queue` + a System-screen panel
with status spinners and capability chips, plus queue depth as the
health metric (TODO item 2); (2) feed reads the lake with "filing…"
state and filed-by/domain chips derived from citations; (3) note view
"touched by" log derived from journal + git (already half-built in
`recentFiles()`/`fmProvenance()`); (4) omnibox capture (`⌘↵` ingest →
`POST /api/drop`, which now lands in the lake); (5) neighbourhood graph
from the existing suggest/link index. The integrations store is
commercialization work, out of scope here. `bigbrain enqueue` /
`bigbrain queue [list|show]` join the CLI for agents (per the
agent-interop doc, CLI-first).

## Phase 5 — one editor: collapse verbs and capabilities (ruled 2026-08-05)

The verb taxonomy and the low/med/high tiers were scaffolding; the
replay A/B that killed the candidate machinery discredited cleverness
in the plumbing generally. The leverage point is capability in the ONE
pass that reads the material. So: one model (the most capable), one
prompt, one message shape.

**Message schema.** `{refs, guidance?, from, via, from_kind}`. Verbs
and capabilities die (`verb`/`capability` on old pending messages:
accept-and-ignore). An arrival is refs-only; a directive carries
guidance; a repair carries refs + structured facts in params. Arrivals
batch at FILE_BATCH_MAX; any message with guidance runs solo.

**One prompt.** Today's file.md plus a `{{#guidance}}` block and the
decline semantics below; link/maintain/synthesize/refile templates
delete, as does the mapRequest verb-guessing heuristic (request text
rides verbatim — no mapping, no parking). `prompts/` = the editor
prompt + discuss.md. `redact` stays reserved OUTSIDE the unified
prompt: it is the one operation that must edit references/, which the
prompt categorically forbids — a distinct runner mode when issue #2
lands.

**Outcome contract** (decline = terminal success). Three terminal
outcomes per ref, one run, no retry ladder, no capability escalation:
- absorbed — verified mechanically by the existing id-match diff scan;
- declined — the model states it in a machine-readable report block
  (`<ref-id> declined: <reason>`); the runner accepts it as terminal
  success, journaled and visible;
- defective — neither absorbed nor declined: straight to the DLQ,
  immediately, visibly. Mechanical failures (spawn/timeout) stay
  retryable; editorial outcomes never retry.

**Emitter grades.** `enqueueMessage` goes internal; three doors:
- `emitArrival(root, ref, identity)` — refs only; guidance
  structurally impossible (intake, import);
- `emitRepair(root, refs, facts, runId)` — refs + structured facts,
  stamped `via: run:<id>` (the runner; never prose);
- `emitDirective(root, {refs?, guidance}, principal)` — prose;
  Principal minted only at credentialed front doors (host shell /
  person-device token → person, verbatim; anything else → agent,
  data-framed — the model's mid-run deferrals come through here).
The rule: minds write guidance (persons verbatim, models data-framed);
mechanisms write refs and facts.

**Replay ledger.** references/ is the record of the world; directives
are the record of what the editor was told and live ONLY in the queue
(never references/). `queue/done/` + `queue/failed/` graduate to
permanent record — never pruned; journal/queue/ carries prompt sha,
model, engine commit per execution. entities/ must be reconstructible
from (references/, person-originated messages, prompt, model): replay
re-feeds arrivals + person directives; messages stamped `run:<id>` /
`import` are derived and regenerate.

**Entity purity + the memory/ punt (ruled 2026-08-05).** Entities are
REAL things that EMERGE from references/ — a dossier is a compression
of the record, never a composition. `entity_type: document` drops (not
renamed): a dossier about a work is content-shaped like an essay, the
smuggling vector for AI-written notes wearing an entity costume.
Papers land in references/, absorb as log lines on the person/org/
project dossiers they substantively concern, else decline. Standing
views ABOUT works get a reserved third tree, `memory/` — deliberately
undesigned until after this phase ships; its existence is what keeps
"no home for this yet" an honest decline instead of entity creep.
Shape: references/ = the world's record, entities/ = what's real in
it, memory/ = what we think about it. `thread` is the boundary case —
decide (narrow to person|org|project|place, or keep) at prompt
cutover, after checking what the live vault already carries.

**Charter killed (ruled 2026-08-05).** The unified prompt is the ONE
editorial policy text — no second steering document. Dies with it:
the `charter:` key in vault.yaml, the manifest field, the worker's
`{{charter}}` render, the ConfigView display (the per-verb templates
that consumed it die in this phase anyway).

Sequence: (1) unified prompt draft (human-edited before cutover);
(2) schema collapse; (3) outcome contract in the runner; (4) delete
templates + mapRequest + DEFAULT_CAPABILITY + CAPABILITIES + verb
switches; (5) re-triage the DLQ under the new contract — most of the
26 should retire as declines.

## Live-vault migration (cache-guitar)

> **Superseded 2026-08-02 (user ruling): fresh start, not in-place
> cutover.** The old vault repo is frozen as a permanent read-only
> archive (git history, journals, machine commits intact — its jobs
> uninstalled), and a NEW vault starts empty under the new contracts.
> The old vault's content enters through `bigbrain import` (#9) like
> any foreign corpus — model-planned ingest, budgeted filing, `origin`
> metadata pointing back into the archive. Consequences: no
> grandfathering is ever exercised on the live vault (the machinery
> stays for in-place upgraders); the new vault is contract-clean from
> note one; the importer's acceptance test is the old vault itself.
> New runbook sketch: merge → engine update on host → freeze old vault
> (final commit, stop jobs) → `bigbrain init` + /setup for the new
> vault (domain set may be redesigned, informed by the import plan) →
> re-point integrations/tokens → `bigbrain import <old-vault>` with a
> reviewed plan → laptop mirrors the new repo. The migration uses a fresh private vault repository; the old
> repository stays untouched as the archive. Open at
> migration time: domain redesign, declined-links ledger carryover.
> The steps below describe the abandoned in-place path, kept for the
> record.

1. Ship phase 1; `bigbrain install` creates `lake/` + `.blobs/`; new drops
   dual-land (lake + inbox) for one release while the old passes run.
2. Ship phase 2; `bigbrain migrate queue` converts pending
   `requests/`; flip the launchd jobs from editor-passes to
   worker-lanes; stop dual-landing.
3. Prompts: regenerate from new seeds, hand-merge the vault's local
   customizations (they win by design — this step is manual and
   documented in the deploy runbook).
4. Standard deploy pattern throughout (push GitHub → host pull →
   `bigbrain install --role host`); old stamps/journals stay readable
   (the existing legacy-fallback pattern, to be shed later in one
   sweep).

## What does not change

Outbox/notify and the dispatcher; drop tokens, scopes, and the auth
store; mirror/pull/publish and the git transport; edge auth on the
viewer; embeddings/suggest (it becomes the engine behind `link`);
the write-guard hook (extended to `lake/` and `queue/`); vault.yaml
domain config and /setup.

## Open decisions (want input before phase 1 lands)

DECIDED 2026-08-02: **cutover, not backfill** — the lake starts empty,
`library/` freezes (backfilling curated artifacts would misrepresent
them as raw sources).

DECIDED 2026-08-02: **payload store = private CAS** (see phase 1) —
not git (scaling), not IPFS (redaction-hostile; ops weight; two
trusted replicas don't need a p2p network).

1. **Lane concurrency.** v1 keeps the single editor lock (one execution
   at a time, fast lane priority). Per-lane locks are easy later;
   starting serial keeps the git-commit story trivial.

## Risks

- **The worker rewrite regresses filing quality** — the passes work
  well today. Mitigation: phase 0 tests first, sandbox-vault
  verification per phase, and the old editor path stays runnable behind
  a flag until the worker has a week of clean journals on the live
  vault.
- **Prompt migration on the live vault** is manual by design
  (vault prompts win); schedule it as its own deploy step, not a
  side effect.
- **Feed/index performance** as the lake grows is the TODO's retrieval
  program (items 1–5); the lake makes those items more tractable, not
  less — but index incrementality (today: wholesale rebuild on any
  mtime change) moves up the priority list once lake items arrive
  every few minutes.
