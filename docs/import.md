# Importing a foreign vault

> **HISTORICAL (2026-08-30, #644).** There is no `bigbrain import` command in the current engine — it went with the editor-era code; this is the design record for #9.

*Issue [#9](https://github.com/elsehow/BigBrain/issues/9). Governing
principles: [design-principles.md](design-principles.md). Ships with the
lake/vault/queue refactor
([plan](plans/2026-07-25-lake-vault-queue.md)).*

`bigbrain import <path>` brings someone's existing note corpus — an
Obsidian vault first, anything file-shaped in principle — into a
BigBrain vault.

## One strategy: ingest

There is no "adopt the tree as-is" mode. Ingest already preserves the
*information*: every note lands verbatim in the lake, its structure,
aliases, tags, and origin folder ride in the envelope, and the whole
corpus is searchable and discussable the moment the import finishes, at
zero model cost. What it declines to preserve is *authority* — foreign
curation does not get to BE the derived view, because vault notes that
derive from nothing and cite nothing are a standing violation of
principle §1, and the content whose curation rules we know least about is
the worst place to start making exceptions.

Good hand-built structure is not lost: it is strong evidence the planner
reads and the filing pass weighs (`origin`, `domain_hint`). The derived
view keeps its shape through derivation, not through exemption.

Grandfathering is a different thing entirely: transition debt on a vault
upgraded in place, worked down by maintenance. No importer ever creates
it.

## Three stages: model plans, code executes

1. **Inventory** (`lib/import/inventory.ts`) — mechanical scan: file
   counts, extensions, a frontmatter-key histogram, directory shape,
   sample paths. No interpretation, no model, no writes.
2. **Plan** (`lib/import/planner.ts`, `prompts/import.md`) — a read-only
   investigation session over the corpus. It samples notes, recognizes
   conventions (which key is really the date, what a folder means, what
   is template detritus), and emits a **migration plan** in the
   constrained schema of `lib/import/plan.ts`. The plan is printed as a
   reviewable manifest and confirmed before anything lands (`--plan-only`
   writes it out to edit; `--plan <file>` runs a reviewed one;
   `--no-plan` skips the model entirely).
3. **Execute** (`lib/import/execute.ts`) — code applies the plan through
   the existing intake waist: envelopes, CAS attachments, sha256
   identity, add-only landing, `import`-authored commits, and a budgeted
   handful of `file` messages. Rule-application by code is what makes a
   5k-file import fast and cheap.

## Rails

- **The model never writes the lake.** Add-only, dedup, envelope
  discipline, and idempotency live in code. The planner's tools are
  read-only and its session runs *outside* the corpus (cwd is a scratch
  dir, the corpus is reached by absolute path) so a foreign vault cannot
  ship its own `.claude/settings.json` or `CLAUDE.md` as trusted project
  configuration.
- **Foreign text is data.** The plan schema is a whitelist: closed key
  set, closed enums, domain hints checked against the vault's own domain
  list, paths that cannot escape the corpus, notes clipped to one line.
  Anything else is dropped with a warning. There is no field an
  instruction could ride in.
- **Foreign frontmatter cannot forge provenance.** `id`, `source`,
  `from`, `sources`, `received`, … are stripped from every imported note,
  as are `kind: request` and `pass: deep` — a note in someone's Obsidian
  vault must not be able to address the editor.
- **Identity is origin path + content hash.** Re-running an import is
  idempotent by construction (the lake's sha256 short-circuit catches
  every already-landed note). Two byte-identical notes at different paths
  stay two items: their duplication is a fact about the corpus, and
  collapsing it is issue #1's business.
- **Dates are the corpus's own.** An item's `received` is its own date
  (frontmatter, then a filename date, then mtime), so the lake tree and
  the feed keep the corpus's chronology instead of burying five years of
  history under one wall of "today". `imported:` carries the real arrival
  time.

## Budgeted filing

Landing the corpus is free; filing it is not. Each item's `file` message
is a model execution, so an import enqueues only `pacing.budget` of them
(default 8, one batch) and the rest drain at the queue's own pace.

The backlog is **derived, never stored**: an imported lake item is
unfiled when no queue message in any state names it. Queue history is
retained forever, so the join is exact and there is no cursor to drift.

- The fast lane tops itself up by one batch **only when it finds nothing
  else pending** (`lib/import/drain.ts`). Organic arrivals always win,
  and an import never pushes the queue into "backlogged". On the standard
  15-minute sweep that is ~750 notes/day — a big corpus files over about
  a week.
- `bigbrain import drain --budget N` enqueues N right now.
- `pacing.file_on_demand` enqueues nothing at import time.

## Operating it

```
bigbrain import ~/Obsidian/personal --kind obsidian --plan-only   # inspect
bigbrain import ~/Obsidian/personal --plan <path>                 # run a reviewed plan
bigbrain import ~/Obsidian/personal --dry-run                     # counts, no writes
bigbrain import ~/Obsidian/personal --yes --budget 25             # apply
bigbrain import drain --budget 50                                 # hurry the backlog
```

Host-only (it writes tracked content). Every run records
`journal/import/<run>.json`: the plan, the planner's model/auth/prompt
hash and warnings, the inventory, and the report — the rule set the lake
was built by, in the repo rather than in `.state`.

## Not yet

- **File-on-demand as a trigger** (a message enqueued the first time an
  item is touched or searched) — the flag exists and suppresses import-
  time enqueueing; the touch hook does not.
- **Two-way sync** with a live foreign vault (the mockup's "obsidian
  vault" store extension). One-shot import first.
- **Near-dup interplay with [#1](https://github.com/elsehow/BigBrain/issues/1)**:
  the same note saved to Obsidian and clipped to BigBrain years apart
  lands twice today.
- **Per-source adapters** (Apple Notes, Notion exports). The generic
  scanner plus model interpretation is deliberately the whole story until
  a corpus proves it isn't.
