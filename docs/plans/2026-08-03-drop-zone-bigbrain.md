# Drop-zone BigBrain — types over domains, no unrequested authorship

**Status:** proposed 2026-08-03, mid-conversation with Nick. Supersedes the
domain-centric assumptions in `2026-07-25-lake-vault-queue.md` (the lake /
queue / derived-view spine stands; what the derived view *is* changes).

## The turn

BigBrain has been a mix of two things: content **dropped** into it (by a
person or an integration) and content **it wrote itself** (the editor
authoring curated topical notes). A provenance census of the frozen
`~/s-tier` vault (1,614 notes) made the split concrete:

```
DROPPED — 681 (42%)                 AUTHORED by the editor — 933 (58%)
  transcript          263             entity dossier            504   ← type-derived
  reference/clip       194            meeting dossier           262   ← type-derived
  dream               135             curated domain note       167   ← freelance
  agent session note    75
  email / record        14
```

The authored column is not one thing. **766 of 933** are *type-derived*
maintenance — an entity dossier is "everything the drops say about this
name," a meeting dossier is "the readable version of that transcript."
These are keyed by **type**, not domain, and the rules that produce them
("maintain a dossier per entity") never mention a taxonomy. Only **167**
(~10% of the vault) are freelance topical essays the editor decided to
write and place — and that category is exactly the drift-and-staleness
risk, *and* the strongest work in the vault both live in it (the health
investigations: multi-year lab syntheses with weighted hypotheses and
explicit disconfirmers — see the Deep Think note below).

## Rulings (Nick, 2026-08-03)

1. **Domains are demoted from architecture to optional config.** They earn
   nothing retrieval needs; the planner even re-derived Nick's five from
   the corpus alone, which proves they're *emergent*, not load-bearing.
   Filing needs a target *note*, not a target *category* (zettelkasten:
   keep/junk, update-or-create, link). Replay needs lake + queue + prompts
   + model config — not a taxonomy. A vault may still declare domains, but
   the engine stops assuming them.

2. **Types become the engine primitive.** A type is intrinsic to the item
   and *implies behavior*: `entity` → merge/dedup/alias (verdict-ledger
   consumers), `transcript` → cleaned reading/diarization, `reference` →
   URL/citation, `dream` → the dream flow. The engine can *act* on a type;
   a domain only ever named a folder. Starter set to design:
   `note · entity · reference · transcript · meeting · dream · record`.

3. **No unrequested authorship.** BigBrain receives, types, dedups, links,
   and maintains **type-derived views**. It does **not** freelance topical
   essays. Synthesis that used to be freelance authorship comes from:
   - **integrations on top of the vault** — e.g. **Deep Think**, a
     synthesis integration; its notes are drops, `filed_by: Deep Think`
     (prototyped 2026-08-03: the two health investigations re-attributed
     to `deep-think`), OR
   - **standing orders** — a `synthesize`/`maintain` request the user (or
     an agent mid-session, with real context) places once; the output is
     contestable against *the ask*, and staleness is the order's explicit
     obligation, not an accident.

4. **The editorial policy survives as a charter, not routing descriptions.**
   The domain descriptions were doing double duty: taxonomy *and* values
   ("when in doubt about health, INCLUDE it"). The values half moves to a
   single **vault charter** — one prose block in vault.yaml that briefs
   every pass on what this vault cares about, what's junk, where to be
   paranoid. The keep/junk call needs the charter; it never needed folders.

5. **Topical grouping, if ever wanted, is emergent — a lens over links,
   not a routing input.** The editor may *report* "a finance-shaped
   cluster is forming"; it is never *commanded* to maintain one.

## Consequences (the cuts, cheapest-reversible first)

- **[cut 1] Capability-tier settings.** The config UI still shows
  triage-model / deep-model — legacy costume. The engine already runs on
  `queue.capabilities.{low,med,high}` (the de-laning, 2026-08-02). Migrate
  the settings surface to three tiers + one debounce; retire the
  triage/deep vocabulary from config. *No engine behavior change.*
- **[cut 2] Kill the routing-policy view.** The domains config panel *is*
  the routing surface; with domains demoted it configures nothing. Replace
  with the charter editor + the type list.
- **[cut 3] Types in the envelope + intake.** *(done 2026-08-03: 45236eb +
  dc83eda)* `type` becomes a first-class envelope field, DECLARED by the
  delivering integration and normalized mechanically at lake landing
  (legacy `kind:` mapped, bare drops default `note`, unknown values pass
  through, `entity` derived-only). The feed renders the type as a solid
  chip on pending rows. Executed with the wipe on bigbrain-vault: 423
  `domain_hint` stamps stripped from lake envelopes, the 15 domain-filed
  notes (incl. three INDEX.md) deleted — a domain index is an index with
  only a category; the entity dossier is the one maintained hub form.
  Bycatch: granola + email had bypassed the lake with raw inbox writes —
  both now deliver through the intake waist, and their direct editor
  spawns are gone (the systemd timer is the one switch for editor runs).
- **[cut 4] Filing becomes update-or-create + link, charter-guided.** The
  editor stops authoring topical notes; it maintains type-views and places
  drops. Freelance-essay prompts retire.
- **[cut 5] Standing orders.** `synthesize`/`maintain` requests as durable,
  user-placed work with explicit refresh obligations (the health-
  investigation pattern, but warranted).

## What does NOT change

The lake (add-only, CAS), the typed queue, one worker / one debounce,
citations, the verdict ledger, entities-as-first-class. This plan is about
the *derived view's contract*, not the spine. Today's cutover
(`bigbrain-vault` on cache-guitar) is unaffected — the five domains stay as
ratified config until the cuts land.
