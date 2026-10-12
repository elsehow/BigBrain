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
time. Four kinds:

| Kind | Says | Recorded today in |
|---|---|---|
| prose | text naming entities | `log/assertions/` |
| identity | same entity, not the same, copy of, not a copy, this entity is this source | `log/entity-aliases/`, `log/entity-fold-rejects/`, `log/source-copies/`, `log/entity-sources/` |
| decline | nothing here worth asserting, because… | `log/declines/` |
| retraction | withdraws an assertion of any kind | `log/revocations/` |

- An assertion is live until a retraction names it.
- A source is **settled** when a live assertion of any kind cites it. That
  is the gardener's whole queue rule (§2: work is a view); retracting a
  decline sends its sources back.
- An assertion that cites nothing (a fold made by hand) is valid, but it
  never enters a lens or a server (below).
- A model's copy judgment keeps its score; the gardener's fold proposals
  (`.state/entity-folds.json`) stay derived state, and settling one writes
  an identity assertion.

Not the record: run journals (`journal/`), `memory/` (the memory pass's
output, drawn in your own field only) and `.state/` (disposable).

## The function

```
field(scope) = layout(graph(live assertions in scope, the sources they cite))
```

- **Graph.** Nodes are the entities named and the sources cited. Edges:
  each assertion's entities to its sources; entities named together; links
  in the cited sources' own text. Identity assertions merge nodes or keep
  them apart. Declines draw nothing.
- **Live only.** A retracted assertion is as if never made: "n, retract n,
  m" draws the same as "m".
- **Layout.** Each node is seated in the order its assertions were added
  (ties by id), beside the earlier nodes it arrived linked to; then a
  settle in which each node's place depends only on its own seat and its
  neighbours' seats. The same input draws the same picture on any machine.
  A new assertion nudges its neighbours; a retraction can move what sat
  beside it.
- **You leave your own view**, as today.

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
published; declines are not. The shared server accepts identity
assertions, so a fresh BB applies them too.

## How it stays fast

- **One maintained view per vault**, updated from the change log. Each
  assertion contributes a fixed set of connections, already recorded per
  assertion (`graph_evidence`, #254), so a commit adds or removes only its
  own. A scope's graph is the connections whose assertions are in it.
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
3. **The pre-#496 trees.** Import as sources what isn't one yet: 232 of
   the 932 `references/` files, `inbox/` (337) and `requests/` (7). Then
   delete `references/`, `inbox/`, `requests/` and `entities/` (267). The
   700 references already imported stay as sources; readers stop taking a
   path from their `imported_path`. The entity pages' alias lists already
   became alias records (migration 1).
4. **Deleted outright:** `log/attestations/` (540 "X submitted this
   source", each repeating a field of the source it cites) and
   `log/goal-assertions/` (2,492 old per-source gardening records nothing
   reads).

No assertion in the large vault uses the old exact-quote citations, so that
format and its decode go too (#231's last item), once the other vaults are
checked.

## What goes

- The separate identity, decline and revocation logs and their readers.
- The markdown projection for everything but `memory/`.
- #240's lens rule (any cited note counts) and fading in place.
- #249's separate server-field code, and the per-window polling in
  `lib/sharedWorkspace.ts`.
- Today's layout, which starts from the previous one (#244 placement).
- Asking each server for its feed head on every read.
- #251's scoped-summary special cases.

## Order of work

0. Merge main up through the stack (#235 to #254 conflict with it in ten
   files).
1. Assertion kinds in the schema and the projection; new writes use them,
   and the old logs are still read.
2. Migrations 1–4, with consent, each proven on the scratch copy; then the
   old readers go.
3. Scopes: the graph from a set of assertion ids; lenses by "all"; a
   server as its own scope.
4. Layout: seats in `added` order with the local settle, for every scope.
5. Servers held locally through their feeds; pushes from the change log.
6. The shared server accepts identity assertions; publishing sends them.
7. Graph deltas: per-assertion updates, and pushes that carry only them.
