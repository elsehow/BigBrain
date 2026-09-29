# Shared source contributions and withdrawal

Status: implementation plan, 2026-09-29. The settings workbench simulates this
interaction; no withdrawal API or automatic inclusion service is implemented.

## Product contract

A member can withdraw or restore their own contribution. A source can have
several contributors: withdrawing one attribution must not remove the others.
Personal originals remain intact. Withdrawal is retained in Added by you and
excludes the member/source/vault combination from future automatic or historical
imports until explicit Restore. Editing/recreating a rule must not clear this.
Owner moderation is a separate attributed action, never impersonated withdrawal.
Withdrawal hides content from active shared views, not from historical backups
or copies already downloaded. It is not a hard-redaction promise.

## What exists

`lib/sharedMembers.ts` authenticates a stable member ID and scoped credential.
`lib/sharedVault.ts:dropEvidence` stamps submitted_by_id, submitted_by and
submitted_via into evidence. Origin author is separate, claimed metadata.
Insertion IDs include the credential-bearing envelope; consequently a new device
can produce a distinct insertion for the same member and content. Neither an
insertion ID nor a credential ID is sufficient as the contribution identity.
Assertion retraction and owner moderation already exist in `sharedVaultApi.ts`.
Source withdrawal, contribution grouping and read filtering do not.
`sharedWorkspace.ts` builds the shared UI projection from evidence and assertions;
`sharedConnections.ts` keeps credentials outside vaults and out of the browser.

## 1. Contribution identity and durable state

Introduce a contribution identity scoped to authoritative vault ID, member ID
and stable source identity. Keep source revisions/insertion IDs as evidence refs,
not owners. Group matching evidence for presentation while retaining each member's
attribution and exact content revision. A claimed origin ID is not ownership or
proof of equal content: differing bodies never silently overwrite one another.
For imports, map personal source identity to a stable opaque server source key;
do not expose local paths. Persist server receipts and rule/version attribution.

Record contribution, withdrawal and restore events with `lib/eventLog.ts`,
reusing the journaled write/feed path in `sharedVault.ts`. Server stamps actor,
credential, receive time and sequence. Keep an append-only transition history;
derive current status. Withdrawal covers that member's revisions of the source,
including future submissions, until explicit restoration. Initial duplicate
submissions and retries cannot reactivate a withdrawn contribution.

Derive legacy attribution from verified submitted_by_id and group across
credentials. Preserve insertion IDs and citations; use a replayable backfill or
compatibility view. Missing verified identity must fail closed, never infer
ownership from the article author or client-supplied handle.

## 2. Authenticated API

Proposed routes:
- GET /v1/contributions?mine=1&status=all&cursor=...: paginated receipts, status,
  rule attribution, timestamps, available actions and other active contributors.
- POST /v1/contributions/:id/withdraw
- POST /v1/contributions/:id/restore

Mutations require current write scope AND authenticated member ID equal to the
recorded contributor. Owner status gives no bypass here. Reject forged identity
fields. Apply existing body limits, throttling, strict IDs and credential
revalidation after body read. Include expected transition version and request ID:
retries return the same receipt; stale withdraw retries cannot undo a later
restore. Serialize checks and events through the existing single writer/journal.
Use a separate owner-only moderation transition when adding source moderation;
member Restore cannot override it. Do not widen the assertion moderation route
implicitly.

## 3. Reads, citations and sync

Fold active contributions into source availability. Exclude withdrawn-only
content from normal evidence lists, detail bodies, search, graph, recents and
agent reads. Another contributor's active copy remains accessible with its own
attribution; no silent substitution of a different revision. History endpoints
return tombstone metadata for withdrawn content, not a hidden raw-body bypass.
Audit feed payloads and every direct file/blob/export route for the same policy.

Assertions are not automatically retracted: they are separately authored claims.
Keep citation IDs resolvable as withdrawn-evidence placeholders when their exact
revision is unavailable. Preserve authorship and allow the assertion's author to
retract separately. Avoid leaking withdrawn body text via snippets or caches;
existing assertion quotations are separate contributions, not secretly rewritten.
Feed withdrawal/restoration events to clients, invalidate projections and search,
and replay after offline reconnect. Server backups retain the original record.

## 4. Inclusion and app integration

Store durable exclusion by vault/member/source, independent of rule version.
Local historical tests report withdrawn matches separately and never preselect
them. Rule workers check exclusions before enqueue/send; the server independently
rejects automatic reactivation, including stale jobs and other devices. Restore
is a distinct explicit authenticated operation. Preserve exclusions across
reconnect and credential rotation using server state, not local connection IDs.

Add explicit local adapter routes in `sharedWorkspace.ts` through
`sharedRequest`; retain the local request boundary and never expose bearer keys.
Connect the production Vaults settings panel to server receipts. Show Withdraw
only for own writable contributions, with pending/error state. Update status only
after acknowledgment; failure leaves the contribution unchanged. Withdrawn rows
show Restore and explain that automatic inclusion will not re-add them. Other
contributors remain visible. Personal original and personal search stay intact.

## 5. Acceptance tests and delivery order

1. Data model/replay + legacy attribution tests before API/UI integration.
2. API authorization and idempotency: own vs other member, owner vs non-owner,
   person vs delegated credential, read-only/revoked mid-request, forged IDs,
   credential rotation, double click, crash recovery, stale retry after restore.
3. Two members share one source; one withdraws, the other remains. Last withdrawal
   removes active availability; exact-revision citations become placeholders.
4. Rule retry, rule recreation, second device and historical import cannot
   reactivate a withdrawal. Explicit restore can; owner moderation still wins.
5. Verify lists, detail, search, graph, feed and caches after transitions and full
   replay, including offline reconnect and retained assertion quotations.
6. Wire real SettingsPage into AppShell and test pending/failure, recent/history
   parity, count, Restore, duplicate attribution, and unchanged personal source.

First backend slice: authenticated own-contribution history + withdrawal/restore,
visibility filtering and replay tests. Then connect the settings UI. Automatic
inclusion machinery consumes this contract when implemented; it must not ship
with only a client-side exclusion check.
