# The memory pass's assertion-era inputs

**Decision record for #445** — third in the era-port series after filers
(#433, `canonicalFilerIndex`) and category (#443). Settled 2026-08-21 per
the shape from the 2026-08-20 session discussion; implementation is #459.

## The problem

The memory pass (lib/memoryRun.ts) is cursor + delta + fold-in: current
tree, observations spool, and the queue ledger's done-messages since
`MemoryStamp.doneCursor`. That delta stream is an indirection over what
the EDITOR did to reference files. On an assertion-native vault the
editor's ledger goes quiet while the insertion and assertion logs fill
up: the pass would truthfully report "no record changes" forever. The
delta stream must move to the substrate that actually records change.

## Decision 1 — the delta stream is cursors over the two append-only logs

`MemoryStamp` (lib/memory.ts, `.state/memory.json`) gains two ADDITIVE
fields; nothing existing is renamed or removed (design-principles §5 —
no migrations, tolerant read):

```jsonc
{
  "doneCursor": "…",                      // legacy field, kept as-is
  "insertionCursor": { "at": "…", "id": "ins_…" },
  "assertionCursor": { "at": "…", "id": "ast_…" }
}
```

- A cursor names the newest event FOLDED IN, as the `{at, id}` pair the
  log readers already sort by (`received_at ?? occurred_at` for
  insertions, `created_at` for assertions; id is the tiebreak). "Past the
  cursor" is exactly the reader's order: `at > cursor.at || (at ===
  cursor.at && id > cursor.id)`. Immutable events make this replayable —
  the same cursor always names the same delta.
- An absent cursor means cursor zero: fold from the beginning of the
  log. That is not a transition hack, it IS the #459 from-scratch
  regeneration posture — a fresh native vault and a deliberate
  `--from-scratch` run take the same path.
- **Which vault mode drives due-ness** follows the same gate the rest of
  the engine uses (`hasAssertionEvents`): a native vault's `memoryWork`
  counts assertion events past the cursor; a legacy vault keeps counting
  done-messages past `doneCursor`, unchanged. The done-ledger path
  retires with the reference era, not before.

## Decision 2 — assertions are the primary input; raw arrivals are inbox state

The prompt's "Record changes since last run" block is replaced, for
native vaults, by two blocks rendered from the logs:

- **New assertions since cursor** — the semantic delta. Each rendered
  with its id, text (canonical `[[ent_…|label]]` links intact),
  confidence, created_at, and the titles of its cited sources. This is
  what the pass folds in.
- **Arrived, not yet asserted** — insertions past the insertion cursor
  that no assertion cites yet: count and titles only. Inbox awareness,
  never working-set input — feeding raw arrivals to the most expensive
  pass would re-do extraction inside it.

Corollary, deliberate: **only assertion deltas (and observations) make
the pass due.** A raw arrival alone does not trigger a run — its
assertions will, when extraction lands. Memory freshness is bounded by
extraction cadence; memory is deliberately the slowest layer.

## Decision 3 — memory claims cite assertion ids

Every factual claim a native memory run writes ends its line with one or
more assertion citations in the vault's own link vocabulary:

```markdown
The demo team maintains the sample library. [[ast_1a2b3c4d5e6f7a8b9c0d1e2f]]
```

- The token is `[[ast_<24 hex>]]` — a wikilink whose target is an
  assertion id, exactly as assertions themselves link `[[ent_…]]`.
  Renderers/resolvers that don't know assertions yet degrade to showing
  the bracketed id (tolerant read); the viewer can later resolve it to
  the assertion's text and cited sources.
- Multiple supporting assertions stack: `[[ast_…]] [[ast_…]]`.
- Validation is strict at write time (#459): the runner rejects a run
  that emits an `ast_` citation absent from the projection. Prose that
  makes no factual claim (headings, navigation, the index's hook lines)
  carries no citation; every claim-bearing line must.
- The prompt states the convention; CODE enforces it — same division as
  the write-scope and budget contracts.

This is what makes decay computable: "which memory lines cite assertion
X" becomes a mechanical index. The **staleness work-list** (claims whose
cited assertions are later superseded or contradicted) is anticipated by
this convention and lands as a follow-up — it additionally needs a
supersedes/contradicts edge between assertion events, which does not
exist yet and is NOT settled here. Nothing about the citation syntax
would change when it lands; that is the point of settling citations now,
since retrofitting them later is a migration, which §5 forbids.

## Decision 4 — decay survives the delta framing

A pass that only folds deltas degenerates into a log with a summary
voice. Unchanged and restated: the re-compete invariant holds — every
run leaves the tree a fresh bootstrap would write today, every claim
re-earns its place against the CURRENT record, and the observations
spool (eventually the retrieval ledger) is the demand-side signal for
what is actually earning its place. The delta blocks are triggers and
attention-direction, never the working set's boundary.

## Untouched by this decision

The observations spool, the write-scope/commit contract (#107), the
budget (9 files / ~3,300 words), the runner's lock/stamp/journal
mechanics, and the queue ledger itself (it remains the queue's audit
surface; it just stops being memory's change-log on native vaults).

## Acceptance mapping (#445)

- Written decision before the ledger goes quiet — this document.
- Cursor fields for both logs in the stamp — Decision 1.
- Prompt input blocks rendered from assertion deltas — Decision 2.
- Citation convention specified, additive, tolerant-read, anticipating
  the staleness work-list — Decision 3.
- Observations and write-scope untouched — Decision 4 / above.

Implementation, regeneration procedure, and rollout: #459.
