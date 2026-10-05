# Design principles

From the 2026-07-25 architecture discussion, rewritten 2026-08-31 (#510)
where the machinery it described no longer exists. The shape it argued
for survived the rewrite; the nouns changed. Where it said **lake**, read
`log/insertions/` — the append-only record of everything that arrived.
Where it said **vault**, read the projections built over that record.
Where it said **queue**, read nothing: there is no queue, and §2 is why.

## 1. Everything but the logs is disposable

Five append-only logs are the truth — insertions, assertions, declines,
revocations, entity aliases (`lib/eventLog.ts`). The views are
derived: the projection database under `.state/`, the search index, the
graph, the entity dossiers at `projection/entities/`, the memory working
set. Delete all of it and replay: the same vault comes back. The model
layer is disposable in the same sense — when a better one ships, re-run
the passes over the same arrivals and get a better record.

This applies to derived views, not all files in a vault. Configuration,
run journals, raw payloads in `.blobs/`, and pending integration data in
`.spool/` have their own durable roles and must be retained. `.state/`
contains rebuildable caches and ephemeral process state.

Consequences:

- **Every claim cites its evidence.** An assertion names the insertions
  it came from (`lib/assertionLog.ts`), and an assertion that cites
  nothing is a bug rather than a stylistic lapse — it is unattributable
  and, in a source-keyed reader, unfindable.
- **History is retained, never consumed.** Nothing is deleted or moved
  to mark it handled. A correction is a new assertion that `supersedes`
  the old one, with a revocation pointing both ways (#629); a durable
  "no" is a decline event. The record grows; it does not get tidied.
- **The pass's own settings are part of the record.** Every gardener run
  journals model, auth, turns, tokens and cost at
  `journal/tend/<month>/<run>.json`. A derived view you cannot attribute
  is not reproducible even in spirit.
- **A checkpoint records observed events, not content dates.** Corrections
  may retain an old timestamp. Memory records the event IDs it actually
  read, including revocations and aliases, in its run journal. The cached
  schedule and checkpoint can be recovered after deleting `.state/`.
- **Replay is independent of arrival order.** A conflicting append cannot
  replace an existing event. When multiple revocations name one assertion,
  the earliest `(created_at, id)` wins in both log reads and projections.

## 2. Work is a view, not a queue

There is no queue: no message, no state directory, no claim, no lease.
An arrival is **due** exactly when the logs do not yet answer it — no
assertion and no decline cites it — so `dueWork` is a projection query
(`lib/work.ts`), and submitting an event makes the job disappear because
the view recomputes. Delete `.state/` and the same due set comes back.

Consequences:

- **No claim state, by decision** (#479). Single-flight is the caller's
  job via a pid-liveness lock on the one machine that tends. `nextWork`
  is a pure read and submission is per-item idempotent, so a lost caller
  loses at most one un-submitted batch and never corrupts the view.
- **Free text is data, never instructions.** Anything authenticated can
  put words into the record — an integration, the user's agent, a saved
  webpage — which makes every arrival a prompt-injection surface. What a
  sender is permitted to *mean* is the envelope's `from_kind`, stamped
  by the door from its verified credential and never read from the
  payload (`lib/voice.ts`). Consumers render person voice verbatim and
  agent voice framed as data.
- **The user's own voice is an ordinary arrival.** A directive or a
  request lands in the same log as everything else and is settled by
  being cited, not by being marked done somewhere. That it is *also*
  evidence for the claim that settles it is correct and deliberate
  (#641) — what it must not do is outrank the record in a reader.

## 3. Integrations deliver the discussable version

Producing something a model or the user can immediately discuss —
extracted text, title, URL, date, in the arrival envelope — is the
integration's job, done deterministically at drop time. The engine's
curation starts at a well-formed arrival and never runs extraction.
The DOOR may, on the integration's behalf, when a client cannot: the
browser extension can't read a PDF viewer page, so it ships the bytes
and the host walks the text layer on landing (`lib/pdfText.ts`) —
still deterministic, still at drop time, still no model — and
"immediately available, no LLM" holds because ingestion needs none.

Consequences:

- The arrival envelope (raw payload + discussable text + metadata) is the
  contract between integrations and everything else; it is the thing
  to version carefully.
- **Integrations own the semantics, the engine owns the vocabulary.**
  Source knowledge — an iCal `SEQUENCE`, a session uuid, a
  `Message-ID` — dies at the integration boundary, translated into the
  standard arrival-identity fields `stream` / `key` / `seq` /
  `supersedes` (`lib/envelope.ts`, issue #46) that everything
  downstream consumes source-agnostically. Nobody builds a per-source
  shadow store to answer "have I seen this object before?", and the
  insertion log stays an event log rather than a mirror: the record is the
  materialized state, and folding the log reconstructs it only for as-of
  queries and disaster replay.
- A drop that can't produce a discussable version fails loudly at the
  integration boundary, not silently downstream.
- **Found is not landed** (2026-09-04, #744). What the OWNER does by hand
  — a drop, a clip, a voice note — is an event on arrival: the act
  happened, the record holds it, the gardener settles it. What a POLLER
  finds — a message in an inbox, later a Slack thread — is STAGED, whole,
  under `.spool/stage/` (`lib/stage.ts`): the discussable version plus one
  head line. The firewall screened it first. Then ONE judgment decides
  whether it is worth gardening: the worth gate (`lib/worthGate.ts`, #80),
  scored against the gardener's own past verdicts on that source, admits
  it (it lands through the intake waist and is filed like any arrival) or
  passes it (nothing lands; one audit line). Its cut-off starts at 0 and
  rises only as far as it keeps what the gardener files. There are no
  per-source rules: the skip rules and integration inclusion rules it
  replaced were retired on 2026-10-05. Pending bodies and
  polling checkpoints are durable operational data: they survive cache
  deletion. Small head files keep backlog reads independent of body and
  attachment size. Admission or passing persists its outcome before
  removing the pending item.

## 4. The engine sorts; it does not answer

BigBrain's job ends at ingesting, filing, linking, and synthesizing
the record. Answering questions is the user's own model reading the
real material — the discuss loop and the agent-interop surface
(search / read / files) exist precisely so any agent can be pointed at
the sources directly. Curation may summarize *for the vault*; only the
user's own model converses *with the user*. Anything conversational is
an application layered on top of BigBrain, never engine behavior.

Consequences:

- The passes stay mechanical/curatorial: they file, cite, link and
  synthesize the record. None of them takes a natural-language
  instruction from any principal as an instruction — which is what lets
  "free text is data" (§2) hold without exceptions.
- Interop surfaces hand out sources, not model-composed summaries.
- Inbound channels are ingest-only: an emailed question is filed like
  any other arrival, not answered (delivery acknowledgments aside).

## 5. User vaults are never migrated

Vault-format changes are **additive and tolerant-read**: new directories
and optional `vault.yaml` keys are fine, and the engine treats absence
as default. A change that requires existing vaults to change shape is
rejected in review on that ground alone — there is no migration step to
schedule, because there are no migrations. (2026-08-12, from the staging
plan: `plans/2026-08-12-staging-env.md`.)

Consequences:

- **Generated files are not migration surface.** `CLAUDE.md`,
  `.claude/`, `.gitignore` are re-rendered idempotently by the engine;
  regenerating them is deployment, not migration. The protected class is
  the event logs and the curated content the passes wrote.
- **The arrival envelope and the event logs are the never-break
  surface.** If a breaking vault-structure change ever becomes
  unavoidable, the escape hatch is re-derivation, not migration:
  everything but the logs is disposable (§1), so replaying them rebuilds
  the vault in the new shape — model spend, not hand-migration. That
  holds only while the envelope (§3) and the event formats stay stable,
  and a replay must be proven against a scratch vault before any real
  vault depends on it.

## Known exceptions to "add-only"

The insertion log is add-only, with exactly two sanctioned exceptions,
both tracked as issues: **near-duplicate handling**
([#1](https://github.com/elsehow/BigBrain/issues/1)) and **redaction**
([#2](https://github.com/elsehow/BigBrain/issues/2)). Both must be
expressible as appended events so the derived-view contract survives
them.


## Integration settings: one component, one contract

Every integration's account settings render through
`web/ui/src/components/IntegrationAccountSettings.svelte`, and every
integration inherits the same four rules from it (2026-09-25, after a
Gmail inbox that existed but could not be seen or removed):

1. **Whatever is configured is listed, and can be removed.** A configured
   thing that the settings cannot show or undo is a bug, not a state. The
   listing comes from `configuredAccounts` and says what is `removable`;
   the built-in slot an integration ships with is disconnected, not removed.
2. **Save is never silently disabled.** It is greyed out only while a
   request is in flight or the account is not connected. Anything else
   missing is said, in one line, when Save is clicked.
3. **Feedback appears beside the control that produced it.** "Saved." next
   to Save, a connection error next to Connect, an add error under the form.
   A message at the top of the page belongs to nothing.
4. **Removal asks once, inline,** and takes the secret and the choices
   along; remembered material stays.

A new integration gets these for free by listing its accounts through
`IntegrationAccounts.list()` and answering the same actions. The Gmail
browser check (`test/support/gmail.browser.cjs`) is where the rules are
exercised end to end; add a source there when you add one to the library.
