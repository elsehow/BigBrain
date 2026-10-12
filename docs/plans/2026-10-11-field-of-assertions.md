# The field is a pure function of sources and assertions

2026-10-11. Builds on the change-log plan (#232, `2026-10-10-change-log.md`)
and replaces its last open item, pushing joined servers' changes (#230).
Decided in conversation; the migrations below follow the amended
`docs/design-principles.md` §5.

## The sentence

> What arrived (sources) and what was said about it (assertions) are the
> record. Everything the app draws is a pure function of the two.

## The record

**Sources** are `log/insertions/`, unchanged and add-only.

**Assertions** are one schema in one log (`log/assertions/`). Each is made
by a person or a model, cites the sources it rests on, and has an `added`
time. Five kinds, and a stage may add more (Types, below):

| Kind | Says | Recorded today in |
|---|---|---|
| prose | text naming entities | `log/assertions/` |
| identity | same entity, not the same, copy of, not a copy, this entity is this source | `log/entity-aliases/`, `log/entity-fold-rejects/`, `log/source-copies/`, `log/entity-sources/` |
| decline | nothing here worth asserting, because… | `log/declines/` |
| retraction | withdraws an assertion of any kind | `log/revocations/` |
| inclusion | this source is in, or out of, this lens: a model's verdict on the lens's rule, with its score, or a person's thumbs up or down | `~/.config/bigbrain/lenses/` and `inclusion-scores/`, outside the vault |

- An assertion is live until a retraction names it.
- A source is **settled** for a stage when a live assertion of a kind that
  stage writes cites it. For intake that is prose, identity or decline:
  the gardener's whole queue rule (§2: work is a view). Retracting a
  decline sends its sources back, and an inclusion verdict never takes a
  source off intake's queue.
- An assertion that cites nothing (a fold made by hand) is valid, but it
  never enters a lens or a server (below).
- A model's copy judgment keeps its score; the gardener's fold proposals
  (`.state/entity-folds.json`) stay derived state, and settling one writes
  an identity assertion.

**Exact duplicates land once.** Each source also carries a hash of its
content alone: its body and its attachments' hashes, without the
envelope. Today the envelope, with its `received:` time, is part of a
source's id, so the same note dropped twice lands twice, and copy
detection only finds the pair later for a model or you to judge. The door
checks the content hash: an arrival whose content the record already
holds lands nothing and is answered with the source already there. Exact
duplicates already in a vault are not rewritten; each pair gets a "copy
of" assertion made by the system, proven by the hash.

Not the record: run journals (`journal/`), `memory/` (the memory pass's
output, drawn in your own field only) and `.state/` (disposable).

## The function

```
field(scope) = layout(graph(live assertions in scope, the sources they cite))
```

- **Graph.** Nodes are the entities named and the sources cited. Edges:
  each assertion's entities to its sources; entities named together; links
  in the cited sources' own text. Identity assertions merge nodes or keep
  them apart. Declines and inclusion verdicts draw nothing.
- **Live only.** A retracted assertion is as if never made: "n, retract n,
  m" draws the same as "m".
- **Layout.** Each node is seated in the order its assertions were added
  (ties by id), beside the earlier nodes it arrived linked to; then a
  settle in which each node's place depends only on its own seat and its
  neighbours' seats. The same input draws the same picture on any machine,
  so layout uses only arithmetic every machine rounds the same way: no
  `Math.sin` or `Math.cos`, whose last bits are left to the JS engine
  and can differ between the app and a Linux server.
  A new assertion nudges its neighbours; a retraction can move what sat
  beside it.
- **You leave your own view**, as today.

## Stages and views

Every step between the record and the screen transforms a list of items,
and is one of two kinds.

- A **stage** calls a model. It works through the items its own output
  does not yet settle (§2: work is a view) and appends what the model said,
  because a model call cannot be run again for the same answer. A chain
  (`lib/chain.ts`) is a sequence of stages.
- A **view** is a pure function of what was written. It writes nothing but
  caches, so any view can be recomputed and a bug in one never becomes
  data.

**Only stages call models, and only stages and doors write.** A step that
needs a model's judgment splits in two: a stage that judges and records,
and a view that applies what was recorded.

A stage writes to the **record** when anything must agree on its output:
another stage reads it, or it decides what a server receives. Otherwise it
writes to a **memo**, a cache keyed by the stage's version and its input's
content hash, whose loss costs only asking again (a note's briefing). No
stage reads a memo as input.

Everything the UI shows is a view:

| The UI shows | The view | Over |
|---|---|---|
| a field | `layout(graph(assertions in scope))` | sources, assertions |
| a lens | the same, over the lens's members | sources, assertions, inclusion verdicts |
| the feed | feed items by section | `journal/feed/` |
| memory topics | the working set's topics | `memory/` |

The stages:

| Stage | Works through | Writes |
|---|---|---|
| intake (the gardener) | sources no live assertion cites | assertions |
| memory | assertions and voice arrivals past its cursors | `memory/` |
| feed | conversations with assertions it has not sorted | `journal/feed/` |
| inclusion | sources a lens's rule has no verdict on | inclusion assertions |

What breaks the rule today:

- **Lens membership.** A model scores each source against the lens's rule,
  and its verdicts, with the person's thumbs up and down, are kept on one
  machine, outside the vault (`lib/lenses.ts`), and the members are
  overwritten each pass and read back as input. Moving the vault orphans
  them. They become inclusion assertions, and a lens's members a view over
  them (step 4). `lenses-and-servers.md` decided that lenses live on your
  computer; whether they move into the vault is decided in the refactor
  plan.
- **Layout** starts from the previous layout, and the saved layout is
  state (step 5).

## Types

TypeScript cannot prove a function pure, and `as` gets past any type. What
it can do is make each rule below fail to compile at every call site, so
breaking one takes a cast, and a cast can be found.

- **The privacy rules are types only one function makes.** `Live`:
  retractions applied. `InLens<L>`: every cited source is a member of lens
  L, the "all" rule. `Publishable<S>`: every cited source is shared to
  server S. Drawing takes `Live`, a lens draws only `InLens`, and
  publishing takes only `Publishable`, so a caller that skips the filter
  does not compile.
- **A view is handed a snapshot, a stage a model.** A view gets a
  read-only snapshot of what was written, never `root`, which reaches the
  disk, git and everything else. A stage gets the snapshot, a model runner,
  and an append typed to the kinds it writes. Lint keeps view modules from
  importing `node:fs`, `./git` or the model runners.
- **`Stage<In, Out>`** names the kinds a stage reads and the kinds it
  writes, and `settles(out)` the inputs each output settles. Whether a
  stage is due is then one generic function, not one per chain, and what
  a stage may take as evidence is its `In`: the feed's rule that nothing
  it judges comes back to a pass as evidence is a type, not a comment.
- **Stages are open, kinds are one closed union.** Any number of stages
  may be added, and a stage may add a kind. Every view switches over the
  kinds exhaustively, so a new kind does not compile until each view says
  what it draws; most draw nothing. Views fold the kinds directly:
  `legacyShape` (`lib/assertionKinds.ts`), which turns them back into the
  retired logs' shapes, goes.
- **Branded ids.** Insertion, assertion, entity and envelope ids and vault
  paths are distinct types, made only by the parser.
- **Parsed once.** Each log is checked as it is read from disk, and inside
  the engine the types are trusted.

Each step brings the code it rewrites under these types; step 9 brings the
rest.

## Scopes

Every scope is a set of assertions, drawn by the same function.

| Scope | Its assertions |
|---|---|
| your field | all of yours, plus memory topics |
| your field, servers joined | yours and every joined server's; one entity across vaults, resolved through your identity assertions |
| a lens | yours whose cited sources are **all** lens members; none that cite nothing; no memory topics |
| a server | that server's only |

The test for a lens and a server: a fresh BB with no vault, connected to a
server holding only that lens (or to that server), draws the same picture.
"All", not "any": a lens never shows an assertion that would reveal a note
outside it.

**Publishing** keeps its rule: an assertion goes to a server only while
every source it cites is shared there. Prose and identity assertions are
published; declines and inclusion verdicts are not. The shared server accepts identity
assertions, so a fresh BB applies them too.

## How it stays fast

- **One maintained view per vault**, updated from the change log. Each
  assertion contributes a fixed set of connections, already recorded per
  assertion (`graph_evidence`, #254), so a commit adds or removes only its
  own. A scope's graph is the connections whose assertions are in it.
  Every view is built this way, as the sum of what each assertion
  contributes, so every view gets step 8's deltas, not only the graph.
  Layout is the exception: a seat depends on the seats before it.
- **A view's cache key is (view, scope, revision).** A view is pure, so
  nothing else can change its answer.
- **Stages memoize by content.** A model's answer depends only on the
  stage's version and its input's content hash (step 2), so the same
  content judged twice costs no model call.
- **Seats are computed when an assertion is written.** A seat depends only
  on the seats before it; reads never compute layout. Layout is cached per
  scope and revision, and a change rebuilds only the scopes holding an
  assertion it touched. The saved layout becomes a cache, not state.
- **Pushes carry what changed:** the touched assertions' nodes, edges and
  seats.
- **Joined servers are followed through their change feed**
  (`/v1/feed?after=`) into a local store outside the vault. Each feed
  entry becomes a change row, so stamps, pushes and caches work as for
  your vault, and no read waits on the network. This closes #230.
- **Scoped summaries** read only that scope's evidence rows.

What it costs: each scope has its own seats, so a lens's first view lays it
out once. Retracting an early assertion reseats what was seated after it,
beside it. Links resolved by title are not local: a new note named X makes
older `[[X]]` links resolve.

## Migrations

Each runs only with the vault owner's explicit consent (§5), is proven on a
scratch copy of a real vault against the old engine's reading, keeps every
event's author, time and producer, names the event it came from, and is
one commit in the vault. Counts are from the large vault's copy.

1. **Identity records to identity assertions.** 767 alias records (335
   seeded from the old entity pages, 350 undoing seeded ones, 65 accepted
   folds, 17 from the CLI), 14 entity-source bindings, and any copy and
   fold-reject records. An alias's latest-wins becomes retractions: a
   record pointing a label back at itself retracts the alias before it.
   None of these cite sources, so none apply inside a lens.
2. **Declines to decline assertions** (636), **revocations to
   retractions** (1,243).
3. **The pre-#496 trees.** Import as sources what isn't one yet. Every
   one of the 932 `references/` files already was (232 had landed under
   the same id without an `imported_path`); `inbox/` (337) and `requests/`
   (7) gave 10 more. Then delete `references/`, `inbox/`, `requests/` and
   `entities/` (267); readers stop taking a path from `imported_path`.
   The entity pages' alias lists already became alias records
   (migration 1). Done on the large vault, 2026-10-12.
4. **Deleted outright:** `log/attestations/` (540 "X submitted this
   source", each repeating a field of the source it cites) and
   `log/goal-assertions/` (2,492 old per-source gardening records nothing
   reads).
5. **Lens verdicts into the vault**, if they move there. Each rating, pin
   and exclusion in a lens's file (`~/.config/bigbrain/lenses/`) becomes an
   inclusion assertion citing its source, authored by the owner; the
   scores land as one assertion per lens. The files go.

No assertion in the large vault uses the old exact-quote citations, so that
format and its decode go too (#231's last item), once the other vaults are
checked.

## What goes

- The separate identity, decline and revocation logs and their readers.
- The markdown projection for everything but `memory/`.
- #240's lens rule (any cited note counts) and fading in place.
- Lens verdicts and members kept outside the vault (`lib/lenses.ts`).
- `legacyShape`, and every fold over the retired logs' shapes.
- #249's separate server-field code, and the per-window polling in
  `lib/sharedWorkspace.ts`.
- Today's layout, which starts from the previous one (#244 placement).
- Asking each server for its feed head on every read.
- #251's scoped-summary special cases.

## Order of work

`2026-10-12-stages-and-views-refactor.md` breaks these steps into PRs.

0. Merge main up through the stack (#235 to #254 conflict with it in ten
   files).
1. Assertion kinds in the schema and the projection; new writes use them,
   and the old logs are still read.
2. The content hash at the door, and "copy of" assertions for the
   exact duplicates already in a vault.
3. Migrations 1–4, with consent, each proven on the scratch copy; then the
   old readers go.
4. Scopes: the graph from a set of assertion ids; lenses by "all"; a
   server as its own scope. `Live`, `InLens` and `Publishable`; views take
   a snapshot, not `root`. The inclusion kind, and the inclusion stage as
   the first `Stage<In, Out>`; migration 5, with consent; a lens's members
   a view over its verdicts.
5. Layout: seats in `added` order with the local settle, for every scope;
   a view, cached by scope and revision, with no platform-rounded math.
6. Servers held locally through their feeds; pushes from the change log.
7. The shared server accepts identity assertions; publishing sends them.
8. Graph deltas: per-assertion updates, and pushes that carry only them.
9. The rest under the types: intake, memory and the feed as `Stage`s;
   views fold the kinds directly and `legacyShape` goes; branded ids.
