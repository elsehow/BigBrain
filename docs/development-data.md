# Development data

Committed tests, UI scenes, documentation examples, and benchmark fixtures must
use invented data. Generate scratch vaults with `test/support/vault.ts`; use
fictional names, `example.com` addresses, generated IDs, and invented counts.
Choose examples for the behavior being tested: spelling distance, ambiguous
names, ordering, long text, or missing fields.

Do not copy a user's notes, prompts, source filenames, entity IDs, contact
details, relationships, annotations, or model summaries into the engine repository.
Renaming a person in an otherwise real conversation does not make it synthetic.
Documentation and code comments follow the same rule as executable fixtures.

Private profiling inputs and outputs stay outside the checkout. Publish only
aggregate measurements, without queries, excerpts, IDs, titles, or paths that
identify the underlying record. Label generated scenes as synthetic; do not
present their content as the original evidence for historical benchmark numbers.
Live-provider smoke scripts remain explicit opt-in commands.

The optional workbench `*.local.json` previews are gitignored. Keep private graph
previews under that suffix too. Ignoring a path does not remove an already tracked
file or erase earlier commits; review the staged diff before publishing.

## Existing history

Replacing current examples does not remove their earlier versions from Git.
The privacy cleanup found vault-derived examples in older fixture, replay, and
design-document commits, including a deleted retrieval evaluation. Existing
branches and release tags retain those commits. A history rewrite needs a
separate coordinated operation with the repository owner and other contributors;
an ordinary cleanup commit makes no claim to purge historical copies.
