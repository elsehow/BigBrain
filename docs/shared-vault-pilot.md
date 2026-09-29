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

The owner opens Settings → the shared vault → Members to create an invitation.
The name is an owner-assigned display label, not a verified email identity.
Invitations grant read-only or contributor access and create a distinct member
on redemption. The operator CLI can still bootstrap an existing member with
`bin/shared-invite.ts`. Connect vault accepts only that invite link; the server
supplies the name. Invitations are single use, expire, and carry the secret in the
URL fragment. If redemption succeeds but its response is lost, issue a new invite.
The local backend stores the resulting credential in `connections.json` with mode
0600. Neither credentials nor the Jev API key are sent to browser storage.

All remote data endpoints require authentication. Membership and scopes are
checked on every request, including after reading write bodies. Owner administration endpoints require a person credential with write access.
All members can view the active member roster and access levels. Members cannot
create invites, list private invitations, change access, or remove others. The owner cannot be removed or downgraded. Removing a member revokes all
their credentials but leaves attributed contributions intact. Already downloaded
content cannot be recalled. Invite secrets are retained in a private mode-0600
sidecar until use or cancellation so the owner can copy pending links.
See `deploy/shared-vault/bigbrain-shared.service` for a persistent Linux service.

## Rules and contributions

The owner can publish portable `recommended_rules` in vault metadata. A member
chooses a suggestion, resolves its entity mentions against their own vault, and
explicitly saves it. Remote changes never silently alter a saved local rule.
There is one optional enabled rule per connection. Removing it stops future
matching without withdrawing previous contributions.

The editor uses the existing entity mention picker and interactive source ratings
described below. Done saves the rule and its teaching examples for future arrivals. The legacy
historical test/import API remains available, but is not exposed in this editor.
Model settings has an optional Jev API
key flow: Add API key, Save key (validates using sample text), Replace, and Remove.
The key is stored locally in `jev-settings.json` beside connection credentials,
with mode 0600, outside all vaults. The UI never receives saved secrets. Legacy
`TYPESAFE_API_KEY` environment/`.env` configuration is still recognized; explicitly
removing a key in settings overrides it. Without a Jev key, evaluation uses the
configured Quick model and its existing model/subscription connection. A configured
Jev failure is surfaced rather than silently switching providers. Either evaluator
receives the complete candidate source, rule, and entity labels/aliases. The pinned model is
`jev-1.13.0`; a score of at least 0.8 selects a source. This threshold is provisional,
not a measured accuracy guarantee. Each complete source is evaluated with “Does this meet the inclusion rule?”
Sources are never chunked or truncated for inclusion. Provider size errors stop
the evaluation without selecting the source. This is relevance selection, not sensitive-data filtering.

Each upload creates an independent immutable shared source, with an opaque stable
origin key. Private local receipts connect its shared ID to the original source
and revision. Combined reads use this mapping to avoid displaying one's own copy
twice. Later personal edits do not automatically update an existing contribution.
Personal assertions are not automatically published with sources.

Added by you lists active authenticated contributions; withdrawn rows disappear
from this tab and recent contributions. Only their contributing member
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

## Interactive inclusion review

Shared vaults and managed integrations (Email, Granola, That Tracks) use the same
`InclusionRuleEditor`, review API, scoring cache, and saved policy. Three complete
source records are offered at a time with short display excerpts. Opening a title
shows the full source. Rating replaces that card after the selection animation.
Neither scores nor cutoffs are returned by the review API.

Rules and human labels are stored under the local connection directory in
`inclusion-rules/<vault hash>/`, outside source logs. Labels contain private source
snapshots so reevaluation still works after an integration item leaves staging.
Starting another review of the same scope supersedes the earlier session. Draft
labels persist; Cancel leaves the active rule unchanged. Editing a rule preserves
labels and recomputes scores. Model/provider or entity-context changes invalidate
an active calibration and require review again. Provider errors are not negative
labels and never silently switch providers.

Done is available after at least one rating and after pending evaluation completes.
There is no perfect-separation requirement or claim of measured accuracy. Every
rating changes the evaluator context and cache identity. Both Jev and Quick get
up to three nearby include and three exclude examples (bounded excerpts), while
the candidate itself is still evaluated in full. Exact rated content follows
its explicit label. The automatic confidence cutoff remains 0.8; it is no longer
fit to the examples. Scores are provider judgments, not calibrated probabilities.
Candidates are sampled near the uncertain region with an exploration slot.
Predictions made before each rating are retained separately from the human label,
so later evaluation need not grade examples after revealing their answers.

For new items, the example-conditioned evaluator and conservative cutoff decide inclusion. Exact rated
content follows the member's explicit judgment. Changing the source content
requires a new score. Reviewed integrations reserve their staged items for this
controller; gardener admission/pass cannot bypass its verdict. Account connection,
active remembering, rule version, and credentials are rechecked before applying a
decision. Errors leave items staged and appear in integration settings; retries
are backed off. Existing unreviewed integrations retain their gardener behavior
until explicitly reviewed. Existing unreviewed shared rules retain their prior
cutoff until reviewed. No existing sources are retroactively withdrawn or imported
by reviewing a rule.

The controller currently runs with the web/app process. The pilot remains a
snapshot preview and is not an installed desktop release. Mock workbench pages
remain fabricated UI studies; live review is in the normal settings screens.

## Desktop integration

The desktop port is based on engine `698661a`. Shared-vault settings, unified
reads, Jev settings, and the integration review editor run in the normal app
server, using the selected personal vault and its existing Quick connection.
The supervisor owns that server; closing the window does not stop inclusion,
and quitting the app stops the controller. No separate preview is required.
The legacy snapshot launcher remains an optional development tool.

Connection credentials default to `~/.config/bigbrain/shared-connections.json`.
Rules and contribution receipts are adjacent `.rules.json` / `.receipts.json`
files; Jev credentials remain in `jev-settings.json`. These files must never be
committed to a vault. Moving a pilot connection into the app must preserve its
connection ID, credential, rule checkpoint, and receipts. Bind each moved rule's
`root` to its intended personal vault. Unbound rules and rules for a different
personal vault do not run automatically; saving a rule binds it to the current
vault. Calibration snapshots are separately scoped by personal root, so they
must be deliberately moved or re-reviewed rather than silently reused across
unrelated vaults.

## Membership operations and recovery

The desktop proxies membership actions through its existing local trust boundary;
device credentials never reach browser storage. Member-following credentials
issued by the invite flow reflect both access upgrades and downgrades on the next
request. Explicitly scoped legacy/device credentials retain their scope ceiling.

All membership and invitation mutations use `<members-file>.lock`, an exclusive
directory shared by the CLI and server. Never run an older CLI against the live
store. On an unclean exit during a mutation the lock fails closed: stop the
service and all membership CLI processes, remove the empty lock directory, then
restart. Do not remove it while a writer is running. An invite is consumed before
its identity/credential is minted; an interrupted redemption may burn the link.
Issue a new invite if the response is lost or the server crashes during redemption.
There is no automatic retry that creates additional member identities.

Validation: `bun test test/sharedMembershipAdmin.test.ts` and
`node test/support/sharedMembership.browser.cjs` exercise fabricated vaults only.
