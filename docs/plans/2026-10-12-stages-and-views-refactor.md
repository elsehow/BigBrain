# Stages and views: the refactor

2026-10-12. `2026-10-11-field-of-assertions.md` (#257) says where the code
goes: every step is a stage or a view, under the types in its Types
section. This says how the code gets there. The inventory is of main at
e375103 with #268; counts from the large vault are aggregates.

## Where the code is

- `lib/` is 340 modules, 45.6k lines. About 590 function parameters are
  `root: string`, and no id has a type of its own: `lib/ids.ts` holds
  regexes.
- 11 modules call `withVaultSnapshot`; the rest read the disk.
- One chain (`classicChain`: intake, memory, feed). Six more stages run
  outside it, from four other places: a supervisor job, the viewer's
  30-second timer (`web/server.ts:877`), the door, and the read path.

### Stages

| Stage | Runs from | Its output | Fits |
|---|---|---|---|
| intake | the chain | assertions, authored "pi" (`lib/vaultTools.ts:181`); its run record in `journal/tend/`, which alone names the model and is never committed (1,299 in the large vault) | the author names the model; the run record is committed |
| memory | the chain | `memory/`, `journal/memory/`, committed | yes |
| feed | the chain | `journal/feed/`, never committed (504 runs) | commit it |
| copy judging | the supervisor's `copies` job | `copy` identity assertions with their scores | yes, outside the chain |
| lens scoring | the viewer's timer | scores, summaries and members in `~/.config/bigbrain/`; members overwritten each pass and read back as input | no |
| entity folds | inside the memory pass | `.state/entity-folds.json`, overwritten | no |
| briefings, relations | on a read, and warmed after memory | `.state/note-briefings/`, `.state/note-relations/`; a relation takes a cached briefing as input; the key holds `new Date()` | no |
| worth gate | the viewer's timer | `journal/gate/`, never committed; a pass in `.spool/`; samples with `Math.random` | no |
| firewall | inside the door | a withheld item leaves one line in `.spool/firewall/`; outcomes are deleted after 7 days | a stage over the arrivals queue |

The diagnostics probe, connection checks, the model catalog, and the
agents' web search and scan reader call models too, but settle nothing and
feed no view. They stay as they are.

### Views

| The UI reads | Today | What breaks it |
|---|---|---|
| `/api/v2`, `/api/v2/entity` | takes a `db`, memoized per stamp (`lib/v2Read.ts`, `lib/viewStamps.ts`) | nothing: this is the pattern |
| `/api/recent` | the projection | its server arm calls every server live |
| `/api/v2/sorted` | the projection | reads per-machine lens events |
| `/api/graph` | built from a snapshot record (`lib/assertionGraph.ts:21`) | layout seeded from the previous layout (`lib/graphCache.ts:82`); a saved view served while a rebuild runs (`lib/maintainedGraph.ts:149`); the read writes the layout, the view row and `graph_evidence`; `Math.cos`, `sin`, `hypot` |
| `/api/graph` with servers, `/api/graph/server` | | the network on every read; merge order from this machine's connection list; a failed server silently dropped |
| `/api/note` | | several snapshots per response; `memory/` and the raw log read from disk; file mtimes; the network for shared assertions |
| `/api/search` | the core is a view | a disk check and an mtime per hit; the network per keystroke |
| `/api/note-log` | | git history and journal trees, not the record |
| `/api/note-messages` | the voice half is a view | the frozen `queue/` trees (#267) |
| `/api/events` | | runs the notes door and graph rebuilds; reads `.state` status; a random epoch |
| MCP `search_vault`, `read_note`, `load_memory` | | `.spool/` session files; `Date.now`; `memory/` from disk |
| the Field's lens filter | in the browser, by entity ids | members are per-machine |
| read state | | live IMAP behind a 60-second memory cache; nothing recorded |

**Reads that write.** Every note read, search and MCP read appends to
`journal/retrieval/`, which the memory pass commits and weighs. That is a
door, the user's demand, and it stays one: the route calls it beside the
view, instead of the view calling it.

### Doors

Every assertion goes through `appendAndProjectAssertion`
(`lib/assertionProjection.ts:774`). The doors (landing, voice, whoami, the
person's identity assertions, the gardener's `submit`) already fit; each
will take its write, not `root`.

## Seams already here

- `withVaultSnapshot` (`lib/vaultReadModel.ts:87`): a read-only SQLite
  transaction at one revision. It becomes the `Snapshot`.
- `Chain` (`lib/chain.ts`): `due`, `run`, `report` and `scheduledVerdict`.
  It becomes `Stage<In, Out>`, and a chain a list of stages.
- `/api/v2`: takes a `db` and is memoized per stamp. Every view takes this
  shape.
- `arrivalLayout` (`lib/graphLayout.ts:238`): already pure over a server's
  record. The field's layout grows from it (step 5).
- `graph_evidence` (#254): each assertion's contribution. Views become sums
  of these.
- `inclusion-scores/`: scores memoized by content. Memo stages work this
  way.
- `test/shortcutGuard.test.ts`: a test that fails on a forbidden pattern.
  The view guard is another.

## Record or memo

A stage writes to the **record** when anything must agree on its output:
another stage reads it, or it decides what a server receives. Otherwise it
writes to a **memo**: a cache keyed by the stage's version and its input's
content hash, whose loss costs only asking again. No stage reads a memo as
input.

| Record | Memo |
|---|---|
| intake, memory, feed, copy judging, lens verdicts, worth-gate decisions | briefings, relations, fold proposals, lens summaries, rule queries |

A fold proposal is settled by the person's identity assertion, so losing
one costs a proposal, never a decision.

## Method

- **Converted code moves.** A view moves to `lib/views/` and a stage to
  `lib/stages/` in the PR that converts it, and nothing moves before. The
  directories show the progress.
- **A guard from the first PR.** `test/viewGuard.test.ts` fails when a
  module in `lib/views/` imports `node:fs`, `node:child_process`, `./git`,
  `./run/*`, `./sharedJev`, `./askModel`, `./vaultRoot` or anything in
  `lib/stages/`; takes `root: string`; or calls `Date.now`, `new Date()`,
  `Math.random`, `randomUUID`, `Math.sin`, `cos`, `hypot` or `atan2`. A
  second check fails when a module outside `lib/stages/` imports a model
  runner, against an allowlist that only shrinks.
- **Each PR is proven.** A refactor leaves the field digest unchanged on a
  scratch copy of the large vault: `bun run field:digest <vault>`, a hash
  of the live assertions' reading and the graph's structure. A behaviour
  change says what changes and why, and explains its digest change.

## The PRs

R1–R3 need no step of #257 and come first. Step 2, the content hash at the
door, is independent of all of them.

- **R1. Types and guard.** `Snapshot`, `View<T>`, `Stage<In, Out>`, record
  and memo outputs; branded ids made only by the parsers in `lib/ids.ts`
  (insertion, assertion, entity and envelope ids, vault paths);
  `lib/views/`, `lib/stages/` and the guard; `/api/v2`'s modules moved in;
  the digest command. No behaviour change.
- **R2. Stage output is durable.** Intake, the feed and the worth gate
  commit their run records with their runs, sweeping uncommitted ones as
  landing does (`lib/references.ts:170`). The gardener's assertions name
  the model that made them.
- **R3. One scheduler.** Every stage runs from the supervisor through
  `CHAINS`: copy judging, lens scoring, the worth gate, fold proposals (out
  of the memory pass) and briefing warming. The viewer's timer goes, and
  "due" is one function of `settles`.
- **R4. The graph as a view** (step 4). Built from a snapshot and a set of
  assertion ids; nothing written on a read: `graph_evidence` is kept on
  commit, and the saved view is a cache by revision, served only when
  current. `Live`, `InLens` and `Publishable`. The digest is unchanged;
  the layout is still today's.
- **R5. Lenses as a stage and a view** (step 4; lenses live in the vault,
  decided below).
  The inclusion kind; scoring as a stage; members a view with no fallback
  to the previous membership, so an unscored note is pending rather than
  kept; sync diffs that view against the server; migration 5.
- **R6. Note, search and agent reads as views** (step 4). One snapshot per
  request; `memory/` and sources from the projection; no mtimes or disk
  checks; the retrieval door called by the route; a note's history from
  the record, not git.
- **R7. Layout as a view** (step 5). Seats in `added` order, grown from
  `arrivalLayout`, with the local settle; directions from a fixed table,
  not `Math.cos` and `sin`; cached by scope and revision; the history in
  `lib/graphCache.ts` goes. The picture changes once.
- **R8. Servers held locally** (step 6). No network on a read; merge order
  by server id; a failed server is shown, not dropped.
- **R9. Briefings and relations as memo stages.** A read returns the memo,
  or "pending" and asks for the stage; a relation's input is the record,
  not a briefing; the date is an input, not `new Date()`.
- **R10. Gates.** The worth gate a stage whose decisions are record. The
  firewall a stage over the arrivals queue, which is outside the vault by
  design, appending a decision without content for every arrival, passes
  included.
- Steps 7 and 8, as #257 plans them.
- **R11. The rest** (step 9). Intake, memory and the feed fully on
  `Stage`; projection tables per kind, and `legacyShape` gone; branded ids
  everywhere; `/api/events` split into the notes door and stamps read from
  a snapshot.

Left as they are, and named: read state (the mail provider is the truth),
operational model calls, the agents' tools.

## Decided: a lens lives in the vault

#257 makes lens verdicts assertions in the vault. `lenses-and-servers.md`
decided that lenses live on your computer, and `lib/lenses.ts` keeps each
one beside the connection credentials, keyed by a hash of the vault's
path.

- **In the vault.** Moving the vault keeps its lenses (today it orphans
  them), and losing `~/.config` loses nothing. Server members still never
  see a rule: inclusion assertions are never published. The cost: the rule
  and every rating enter the vault's git history and its backup remote,
  and a rule edit rescores every note (about 4,500 in the large vault), so
  a pass lands as one assertion per lens and pass, not one per note.
- **On the computer, as a stage's log.** Keeps the earlier decision. The
  scores and hand edits become an append-only log there instead of an
  overwritten file, and members a view over it. A second machine, or a
  lost `~/.config`, rescores and may share a different set.

Decided 2026-10-12: **in the vault.** A lens's rule and its inclusion
assertions are vault content; inclusion assertions are never published;
a scoring pass lands as one assertion per lens and pass. Migration 5 moves
the existing `~/.config/bigbrain/lenses/` files in, with the owner's
consent, and `lenses-and-servers.md`'s "lenses live on your computer" is
superseded.
