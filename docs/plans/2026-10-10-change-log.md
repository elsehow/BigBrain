# The change log: one ordered stream from commit to client

The engine should know what changed because it made the change, and tell
whoever is looking. Today it knows *that* something changed — the projection's
`revision` counter — but not *what*. So everything downstream rebuilds or
rediscovers: the graph is rebuilt from the whole projection, the viewer pings
every tab with `{"changed":true}`, each tab refetches whole payloads, and a
watcher guesses from filenames. This plan adds the one missing primitive, a
change log written in the commit, and rebuilds the read side on top of it.

Built on #221 (writes project themselves; reads compare revisions instead of
scanning) and #223 (narrow data apart from wide). It answers #226, #228 and
#231, and gives #225 a place to write.

## The shape

```
writers (api, tend, web, mcp, cli)        many processes, as today
  │  append event file (the truth), then in ONE SQLite transaction:
  │  project it · bump revision · insert its change row
  ▼
projection: … + changes(revision, kind, id, op)       the ordered stream
  │  the viewer reads rows past the revision it has seen
  ▼
view maintainer (web, one long-lived worker)    graph+layout, feeds, folds…
  │  each view saved with the revision it reflects
  ▼
viewer routes: lookups of saved views        GET /api/graph → bytes + ETag
  │  event: views {generation, revision, views: {graph: hash, feed: rev, …}}
  ▼
clients: hold stamps, fetch only a view whose stamp moved; never poll
```

There is still no daemon. SQLite serializes the writers, so the change log *is*
the single ordered stream; the sequencer is the database, and the log is its
output.

## 1. The change log

```sql
CREATE TABLE changes (
  revision INTEGER NOT NULL,   -- meta.revision after this commit
  kind TEXT NOT NULL,          -- source | assertion | decline | revocation | alias | entity_source | copy | markdown
  id TEXT NOT NULL,            -- event id, or a note's path
  op TEXT NOT NULL,            -- add | remove | edit
  PRIMARY KEY (revision, kind, id)
);
```

Written wherever `revision` moves today, inside the same transaction:

| Site | Rows |
|---|---|
| `insertOnce` (every projected kind) | one `add` |
| Markdown reconcile (one bump per batch) | one `edit` or `remove` per path |
| Recovery's presence update (a hand-deleted or restored insertion file) | one `remove` or `add` per id |

A rebuild mints a new generation and an empty log; `generation:revision` is the
stream's coordinate, as it already names a published read revision. Rows past a
retention bound are pruned by the maintainer; a reader behind it gets a
snapshot instead of a replay. The log is projection state: disposable, rebuilt
with everything else (design principle 1).

## 2. Waking the viewer

The viewer holds one read connection open. `PRAGMA data_version` on it changes
whenever another connection commits, at the cost of reading the WAL index in
shared memory. Two ways to learn that it moved:

- **Recommended:** watch the single file `assertions.db-wal` as the wake-up,
  and keep `data_version` as the truth. Every commit writes the WAL. A missed
  watch event is caught by the next one, or by a slow `data_version` check (5 s)
  that costs microseconds.
- **Alternative:** poll `data_version` every 250 ms. It is simpler and
  cross-platform with no watcher, but wakes the process four times a second.

Either way the viewer stops watching `log/`. The recursive watcher, the
per-file `projectionHolds` lookups and watcher-triggered recovery (#221) are
deleted. Recovery runs once at each process start. A log file put there by hand
is projected by the next process to start, and tend starts one every five
minutes.

## 3. The view maintainer

A maintainer in the web process keeps the read models the UI asks for, each
saved with the revision it reflects. Builds run in a worker once per revision
rather than per request, so a one-shot worker per build is enough, and no
second copy of the vault stays resident (#235):

```sql
CREATE TABLE views (name TEXT PRIMARY KEY, revision TEXT NOT NULL, hash TEXT, body BLOB NOT NULL);
```

| View | Today | Becomes |
|---|---|---|
| `graph` (+ layout) | rebuilt per revision in a one-shot worker, cloned back with tens of MB of evidence, stringified per request | saved bytes and hash; `/api/graph` answers `If-None-Match` with 304 |
| `v2`, `v2/sorted`, `v2/entity` | decoded and sorted per request | saved per revision, like `read_feed` already is |
| folds proposals, vault counts, copy groups, identity | computed per request on the main thread (#231) | saved per revision |
| briefing evidence | 76k connections scanned per hover | queried by id; not a view (#228) |

**Freshness.** Freshness is a comparison: a route serves the saved view and its
revision. When the projection is ahead, the maintainer is already working,
latest-wins: at most one build in flight per view, and when it finishes, another
build starts if the revision moved meanwhile. A request may ask `?after=R` and
waits, within a bound, until the view reaches `R`. That is read-your-writes for
a client that just wrote, once write routes return the revision they committed
(they don't yet).

**Phases.** The first phase rebuilds a view whenever any row lands that the
view depends on: each view declares its kinds, so journal writes never touch
the graph (#226). The second phase applies change rows incrementally where it
pays: graph edges per assertion, feed rows per source.

**First start.** First start falls out of this. Views from the last session are
still in the database. If the revision has not moved, the viewer serves them
before any build, and the Field draws from a lookup.

## 4. Pushing to clients

The viewer's ping becomes (built in #238; `event: vault` already names the
vault's identity, so the stamps have their own event):

```
event: views
data: {"generation":"…","revision":"…","views":{"graph":"<hash>","joined":"<ids>","feed":"<generation:rev>","files":"<epoch:n>"}}
```

`graph` is the maintained view's content hash and `/api/graph`'s ETag; `feed`
is the last commit the v2 feed reads; `joined` names the shared vaults the
graph merges in; `files` counts watched files outside the projection, for the
views that have no stamp of their own. A client keeps the stamps it fetched
and fetches only a view whose stamp moved. Every connection opens with the
current stamps, so a reconnect needs no `since`: the stamps are the snapshot.

Pilot and desktop lists ride the application channel, whose `pilot` events
already exist and are unused. The Field stops polling. Their routes stop
awaiting a graph build, because the graph is a lookup.

The first version of the push is per-view stamps: a client never refetches an
unchanged view and never polls. Structural graph deltas (nodes and edges added
or removed, from change rows) are the second version, once the Field can apply
them.

## 5. Notes

Markdown is the one input people edit outside the engine. Its door (#225) is a
single watcher over the browse roots with a persisted cursor, which reconciles
each edited path and writes its change row. That deletes the per-read stamp walk
and the one-second clock (`vaultReconciliationDue`). After this step nothing on
a read path checks the filesystem.

## Order of work

Each step ships alone and deletes something.

| Step | Adds | Deletes |
|---|---|---|
| 1 | `changes` rows in every commit; tests that the log equals commit order, and that a rebuild starts a new generation | — (enables the rest) |
| 2 | maintainer worker and `views` table for graph+layout and v2; ETag on `/api/graph`; first start from saved views | one-shot graph workers per request; the `knownRevision` dance; graph invalidation on journal writes; per-request syncs in those routes |
| 3 (#238) | `event: views` with view stamps; `journal` change rows (decision 5); ETag and `?current` on `/api/graph`; desktops on the application channel | `{"changed":true}` and refetch-everything; Field polling; the v2 journal listing; the read-state overlay on the graph |
| 4 (#239) | wake on WAL + `data_version`; `bigbrain recover` | watching `log/`; `projectionHolds`; watcher-triggered recovery; the Markdown walk on every commit |
| 5 | the notes door (#225) writing change rows | the per-read Markdown walk; the one-second clock |
| 6 | remaining views (#231); incremental graph and v2 from change rows | per-request O(vault) routes |

## What a commit still costs (measured after step 4)

On a large vault, one new source reaches open tabs 14–25 s after it commits.
The push itself starts within ~340 ms; the rest is the graph view's rebuild,
which is O(vault) at every revision:

| Phase | Time |
|---|---|
| decode the whole record (`vaultRecord`) | ~7 s |
| republish the recent-sources page (`recentSourcePage`) | ~6 s |
| re-simulate the layout for the new structure | ~5 s |
| build the graph | 0.25 s |

Step 6 is where freshness is won. Part 1 (#242) found the decode itself cheap
(~0.3 s): 13 s was the record reading 72 MB of link evidence the graph view
discards, and the feed page reading every Claude Code transcript blob in each
fresh worker. Schema 23 keeps link evidence in its own table and stores the
transcript's model at projection: one new source now reaches open tabs in
6.4 s, and the layout's 5.5 s re-simulation is the rest. Part 2 (#244) places
what changed into the standing layout: only nodes whose connections changed
move, among nodes held still, and the whole graph settles again after a tenth
of it has moved. Layout 5.5 s → 40–150 ms; a new source reaches open tabs in
0.5–1.6 s.

## Decisions

1. **Wake-up:** watch `assertions.db-wal`, with `data_version` as the truth and
   a 5 s `data_version` backstop.
2. **Views:** in the projection database: one disposable store, published
   atomically with a revision.
3. **Hand changes to `log/`** (a crash between append and projection, a source
   retracted by deleting its file, a restore, an import script): the next engine
   process to start projects them, within five minutes since tend starts one
   that often, and logs them for the viewer. `bigbrain recover` does it at once.
   *Decided.*
4. **Retention:** keep every change row. Rows are about 100 bytes, every rebuild
   starts the log over, and a reader past the start falls back to a snapshot,
   which is always correct. *Decided.*
5. **Journals** (`journal/tend`, `journal/feed`) feed the v2 views but are not
   in the change log, so those views cannot be kept from it yet. Decided:
   journal writes append change rows too (`kind: journal`), so the log is
   every engine write the viewer reads, not only the projection's. The v2 build
   keeps reading the files, which are written once. *Decided; built in step 3.*
