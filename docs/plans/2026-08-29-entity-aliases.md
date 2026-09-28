# Entity aliases — one label names another entity

*2026-08-29. Status: implemented (`lib/entityAliasLog.ts`, projection schema 5,
`bigbrain entity`). **Revised 2026-08-30 — see the last section: aliases are
read-side only, never a bare given name, and the past is corrected per
assertion (#628, #629).***

## The split

An assertion entity's id is `ent_` + sha256 of its normalized label
(`assertionEntityId`). That makes identity content-addressed and mint-free —
and makes `[[Evan]]` and `[[Evan Keller]]` two entities forever, with no
event in the record able to say otherwise.

The examples below are invented. A bare first name can become a separate
entity from a fuller name, and several people can share that first name.
Two mechanisms cause the split:

1. **Minting.** Agent-chat transcripts say first names; the intake prompt
   said *avoid inferring identity from a name alone*; so the gardener wrote
   `[[Evan]]` as a new entity, and the host hashed it into being.
2. **Capture.** Once the stub existed, `search_vault "Evan"` ranked it first
   — `titleTier` puts an exact title match above a partial — with no evidence
   count beside it. The model then wrote `[[ent_<stub>|Evan Keller]]`: it knew
   the surname and linked the stub anyway, because the tool told it that was
   the entity.

Neither is a model-capability failure. The host offered no way to say two
labels are one thing, and the tools offered no way to see which of two
hits was the real one.

## The event

`entity.aliased`, in its own append-only log `log/entity-aliases/` (declineLog's
reasoning: a separate homogeneous log costs one directory; a mixed one costs a
guard in every reader forever):

```json
{ "event": "entity.aliased", "id": "eal_…",
  "alias": "Evan", "alias_id": "ent_<alias>",
  "entity": { "id": "ent_<canonical>", "label": "Evan Keller" },
  "author": …, "created_at": …, "produced_by": … }
```

`alias_id` is `assertionEntityId(alias)`, spelled out so a reader resolves
without the hash. Because ids ARE label hashes, "this label names that
entity" and "merge that stub into this entity" are the same declaration.

Fold rules (`entityAliasResolution`, the one rule set): latest declaration
per alias id wins; `entity.id === alias_id` retracts; a cycle drops its oldest
declaration until none remain; chains flatten so one lookup is the whole
answer. Host-authored only — the gardener never writes this log.

## Where it applies

- **Projection** (`lib/assertionProjection.ts`, schema 5): `entity_alias_events`
  is the sync census; `entity_aliases` is the flat resolved table, rewritten
  from the census on every alias event (tiny table, one rule set, no
  incremental twin to drift); `entity_alias_fts` makes alias labels
  searchable. Raw `assertion_entities` links stay as written — the log is
  immutable — and every entity read (`projectedAssertionEntity`,
  `searchAssertionEntities`, `assertionsWithRefsForEntity`, stats) resolves
  through the table. Search unions own-label and alias-label hits, keeps the
  best score per canonical, and carries the merged count.
- **Log readers**: the entity view and the graph resolve every linked id
  through `entityAliasResolver`. A stub's page path lands on the canonical
  dossier; prose links point there; the front matter lists `aliases`.
- **Intake** (`canonicalizeAssertionLinks`): both link forms resolve through
  the table before the assertion is written — `[[Evan]]` and
  `[[ent_<stub>|…]]` alike become Evan Keller's id. And a label the record
  has never linked is **refused when it is one word that an existing entity
  carries**, with the candidates (most-cited first) in the item's error:

  > `[[Evan]]` would mint a new entity beside ent_<canonical> "Evan Keller" (100)
  > — link one as `[[ent_<canonical>|Evan]]`, or write a fuller label if this is
  > a different entity

  Deterministic, model-independent: the mistake is un-submittable. Multi-word
  labels mint freely; the shared-first-name case stays the model's call, with the
  candidates in hand.

## Seeding

The reference-era `entities/*.md` dossiers already carry alias lists
(`evan-keller.md`: `[Evan Keller, Evan, evan.keller@example.com]`) that nothing
read. `bigbrain entity seed-aliases [--dry-run]` turns each dossier into
declarations toward one canonical:

- **the label the record cites most**, choosing among multi-word names for a
  person. A frequently cited full name should not be replaced just because a
  longer alias exists. Ties prefer a person's longest name, then the title.
- **skip ambiguous labels**, including names shared by multiple dossiers,
  bare first names used under several surnames, labels another declaration
  owns, session IDs, and dossiers with no supporting assertions.

Every skip is reported with its reason. The operation is idempotent: a second
run declares nothing.

## Operator surface

```
bigbrain entity alias "<label>" --into <ent_id|"Label">
bigbrain entity alias "<label>" --retract
bigbrain entity seed-aliases [--dry-run]
bigbrain entity resolve "<label or ent_id>"
bigbrain entity aliases [<label or ent_id>]
```

## Not here (follow-ups)

- Search ranking: an exact single-token title should not outrank a
  multi-token label carrying the token with far more evidence; entity hits
  should show their counts to the model.
- The intake prompt's *avoid inferring identity from a name alone* — swap for
  "a bare first name resolves to the one existing person it matches; several,
  pick by context or disambiguate" now that the guard makes the old failure
  un-submittable.
- A gardener-submitted alias (`submit: "alias"`) is a trust decision not
  taken here.

## Revised 2026-08-30 — aliases are read-side; the past is corrected per assertion

The initial seeding approach was rolled back. An alias is a rule about a
label; correcting old assertions is a statement about those particular
assertions. Even if every past `[[Evan]]` meant Evan Keller, a later mention
might mean someone else. Intake must not link an ambiguous label through a
standing alias rule.

**#628 — intake links the canonical thing only** (`canonicalizeAssertionLinks`):
a `[[label]]` resolves only when it IS an entity's own label; an explicit
`[[ent_…|…]]` only when the record holds that entity live. A label or id that
is an alias is refused naming the canonical (`"Evan" is an alias of ent_… "Evan
Keller" — link [[ent_…|Evan]]`); a retired id is refused naming where its
assertions went; a superseded fuller label is refused with the pointer; the
one-word guard stays. The alias table remains for deliberate, unambiguous
variants (an email, a spelling variant, an org rename) and applies read-side —
search, dossiers, the graph — never at write time. A bare given name is never
an alias.

**#629 — `assertion.revoked` + supersede** (`lib/revocationLog.ts`,
`lib/entitySupersede.ts`, schema 6): the immutable log is corrected by
appending. For each live assertion on a stub, a **corrected copy** — a plain
`assertion.asserted` with the same display words, the canonical id in place of
the stub's, the same `sources` (the insertion stays settled), the original's
`created_at`, `supersedes: <original>`, author = the host procedure
`entity-supersede` — then a revocation of the original with `superseded_by`
pointing at the copy and the operator named in the reason. Readers stay dumb:
`readAssertionLog` drops revoked events; the projection keeps the row (flagged)
and removes its entity/FTS edges, deleting an entity row that nothing live
links — its label is unclaimed again, and the guard owns it. A superseded id
still resolves (`resolveAssertionId`), so a memory topic citing `[[ast_old]]`
keeps drawing until it re-cites. `bigbrain entity supersede <stub> --into
<canonical> [--assertion ast_… …] [--dry-run]`; per-assertion selection is what
splits a mixed stub between the intended people. Idempotent.

Why not a per-assertion *relink*: an assertion links many entities, and a
relink is well-defined per edge — but the immutable event's text still names
the old id, so every reader would carry a second resolution layer. Revoke +
reassert costs one filter instead, and the revocation primitive is one the
record needs anyway.
