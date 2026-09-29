# Shared vault pilot

This experiment uses the production AppShell in a browser, an isolated local read
snapshot, and a remote authenticated vault API. It does not replace the installed
desktop application. Start it from the experiment worktree after `bun run web:build`:

```sh
bun bin/shared-pilot.ts --personal /path/to/personal-vault --home /path/to/private-pilot --port 4778 --open
```

The launcher copies immutable logs into `private-pilot/personal` every 30 seconds;
it never writes the original vault. Changes made in the pilot are local to the
snapshot. Keep the launcher running for automatic inclusion. Closing it stops
both the local UI and inclusion worker. The remote service persists independently.

## Connection and identity

An operator provisions a member and issues an invitation with
`bin/shared-invite.ts`. Connect vault accepts only that invite link; the server
supplies the name. Invitations are single use, expire, and carry the secret in the
URL fragment. If redemption succeeds but its response is lost, issue a new invite.
The local backend stores the resulting credential in `connections.json` with mode
0600. Neither credentials nor the Jev API key are sent to browser storage.

All remote data endpoints require authentication. Membership and scopes are
checked on every request, including after reading write bodies. Invites currently
connect an existing member; membership administration remains an operator CLI.
See `deploy/shared-vault/bigbrain-shared.service` for a persistent Linux service.

## Rules and contributions

The owner can publish portable `recommended_rules` in vault metadata. A member
chooses a suggestion, resolves its entity mentions against their own vault, and
explicitly saves it. Remote changes never silently alter a saved local rule.
There is one optional enabled rule per connection. Removing it stops future
matching without withdrawing previous contributions.

The editor uses the existing entity mention picker. Test rule evaluates all time
or sources added since a date and lets the member import selected matches.
Save and enable applies to future arrivals. Put `TYPESAFE_API_KEY` in the private
pilot home's `.env` (mode 0600). Jev receives candidate source text, the rule, and
entity labels/aliases. There is no fallback provider. The pinned model is
`jev-1.13.0`; a score of at least 0.8 selects a source. This threshold is provisional,
not a measured accuracy guarantee. Long sources are chunked; a matching chunk
selects the whole source. This is relevance selection, not sensitive-data filtering.

Each upload creates an independent immutable shared source, with an opaque stable
origin key. Private local receipts connect its shared ID to the original source
and revision. Combined reads use this mapping to avoid displaying one's own copy
twice. Later personal edits do not automatically update an existing contribution.
Personal assertions are not automatically published with sources.

Added by you lists authenticated contributions. Only their contributing member
can withdraw or restore them, including after credential rotation. Withdrawal
hides that contribution from normal reads and prevents automatic re-addition;
it leaves personal originals and other members' contributions intact. It is not
hard deletion of historical records or copies already obtained by readers.
Transitions use expected versions and idempotency keys to prevent stale retries
from undoing later actions. Uploads are limited to 16 MiB per source.

## Current limits

The pilot is a worktree preview, not a released desktop build. It does not launch
the desktop supervisor or provide full agent functionality. Remote availability
is required to read remote-only items; offline remote views are currently omitted.
Combined search includes remote sources, but not remote assertion-only hits.
The snapshot is not a two-way sync. This is an owner pilot, with no public signup,
member administration UI, automated backup, or hard-erasure workflow.
