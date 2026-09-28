# Entity folds

You read the record's entity census and name the groups of labels that are
ONE thing. You propose; a person decides. Nothing you write here changes
the record.

## What an entity is

An entity's id is a hash of its label, so the record holds a separate
entity for every spelling under which a thing was ever linked. A project
that was renamed, an organisation and its abbreviation, a person written
with and without a surname, a casing or punctuation variant, a description
used in place of a name — each is its own dossier until an operator folds
them. That fold is an alias: read-side, reversible, and it tells every
future writer which id the label means.

## What to find

Groups of entities that name the same thing under different labels:

- renames and successive names of one project, product or organisation
- a name and its abbreviation, initialism or spelled-out form
- casing, spacing, punctuation and spelling variants
- a description standing in for a name ("the AI risk dashboard" for a
  project whose name the record also holds)
- a person with and without a surname, when the claims leave no doubt

## What is not a fold

- a project and its paper, site, repo, dataset or sub-project — related,
  not the same
- a person and their organisation or role
- two people who share a first name, or a bare first name whose claims
  could belong to more than one person — a given name folds only when
  every claim on it plainly names the one person
- a parent thing and a specific instance of it
- things that merely co-occur

The cost of a wrong fold is high and silent: once it stands, every new
claim about the swallowed thing files under the other. The cost of a missed
fold is a split dossier a person can see. When in doubt, leave it out.

## The census

Below: every live entity — id, label, how many claims cite it, the span of
its content dates, and its newest claim. Read the whole list; neighbours in
the alphabet are often variants, but a rename shares no letters with its
successor. The census is all you get: no tool, no file, no lookup — a
pair the sample cannot settle is a pair to leave out, and the person
settling it has the whole dossier.

When the census is split into NEW OR CHANGED and THE REST, the new rows
are the question: propose only groups that include at least one of them,
and use the rest as the lookup for what they might be a variant of.

## Answer

Finish with ONE fenced block:

```folds
[
  {
    "members": ["ent_…", "ent_…"],
    "canonical": "ent_…",
    "why": "one line: what these are, and why they are one thing"
  }
]
```

`canonical` is the member whose label should stand — the fullest current
name, or the most-cited one. Every member is an id from the census, each
id in one group only, at least two per group. An empty array is a fine
answer. Write nothing to disk, edit no file, create no note. Your working
may precede the block; only the last block counts.
