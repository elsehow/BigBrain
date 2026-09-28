---
name: vault-add
description: Add something to the user's BigBrain vault — drop a decision, finding, idea, or piece of research as evidence for the user's own gardener to file, or file a request asking the gardener to change existing notes. Use when the user says "add this to my vault", "capture this", "remember this", "save this for later" — or on your own judgment, when work settles something worth keeping.
---

# Adding to the vault

You add by **dropping evidence** at the vault's front door. You never write
the record and you never write synthesis: a drop becomes an immutable source
event, and the assertions and entities that make up the user's memory are
projected from sources by the vault's own gardener — the user's agent, on
the user's say-so. You contribute evidence; the gardener does the filing.
Your drop is due work the moment it lands, and it is attributed to you.

Use the connected BigBrain MCP `drop` tool. Tool names may have a client prefix.
If it is unavailable, report that the local MCP connection needs setup.

## When to drop

Drop when something **settles**: a decision and its why, a fact about the
world, a change in a person's or project's state, a finding, an open thread
the user will want back. On your own initiative is fine — that is what the
attribution stamp is for.

Not everything is worth a drop:

- **Not the chat log.** External sessions are not automatically captured.
  Drop the *distillate* — the decision, the
  finding — not the exchange. If the exchange itself is the evidence, quote
  the part that matters.
- **Not code minutiae or tool noise.** The record is the user's memory of
  their life and work, not a build log.
- **Not what the vault already holds.** Search first with the `vault-search`
  skill when unsure — restating the record is noise the user has to weed.

## Save a finding

Call `drop` with:

- `title`: a short, descriptive title.
- `body`: the Markdown evidence, including relevant dates and sources.
- `kind`: `note`, `idea`, `finding`, `research`, or `request`.

The server supplies the envelope and attributes the contribution to the MCP
client as an agent. Do not claim to be the user. The returned `id` and `path`
identify the saved evidence; `read_note` can open that path.

Report the item as saved. BigBrain's own background agents handle filing;
do not launch maintenance work from this session. Search later to see what
it became. Saving evidence does not guarantee that it becomes curated memory.

## Ask the gardener to change existing notes

To merge, rename, refile, or fix something already in the vault, do not try
to edit it — file a **request**: the same drop, with `kind: request` and a
body describing the change. A request is the user's standing voice in the
garden: it outranks ordinary intake, and it is settled when the gardener
does the work and cites it — or declines it, on the record.

## Write it for a future reader

An item is a note in someone's memory, not a chat reply. It will be read months
from now by someone — or something — with none of this conversation.

- **Name the concrete nouns.** People, projects, companies, dates. That is what
  the gardener links on and what search later finds.
- **Say what was decided and why**, not only what was discussed.
- **State the date of anything relative.** "Next Tuesday" is worthless in the
  record; write the date.

## Whose words are these?

Everything you write is stamped as *yours*, and the passes weight the user's
own voice above every other signal. So a paraphrase you attribute to the user
becomes a false fact in their memory, in their voice.

- **Relaying the user: quote them verbatim, in quotation marks, dated.** Keep
  your own framing outside the quotes and marked as yours.
- **Never prefix their name onto a paraphrase.** A quote inside your drop is
  still your drop — the attribution stays yours, and that is the point: the
  reader can always tell a relayed quote from the user's own hand.
- **First person is for what you did, needed, or inferred.**

## Don't

- **Don't file it yourself.** Do not try to choose a folder or a filename —
  landing routes it, the gardener places it, and misfiling is worse than
  letting it route.
- **Don't assert.** Conclusions about what your evidence *means* are the
  gardener's to draw, in the user's garden, under the user's control.
- **Don't drop what you haven't checked.** Search first; the record may
  already say it better, with better provenance.
