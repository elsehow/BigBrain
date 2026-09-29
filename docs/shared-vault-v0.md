# Local shared-vault v0 assessment

The recovered prototype (through 2be1653) applies cleanly to public main
9686f88. It is a backend and CLI, not a desktop workspace switcher.

## Verified

On macOS with Bun 1.3.9, all 31 targeted tests passed with 508 assertions,
including real HTTP using fetch and curl, graceful restart, forced crash,
feed resume, concurrent writes, attribution, authorization, and revocation.
No tests were skipped. This is targeted verification, not a complete security audit.

The old handoff runner incorrectly requires an explicit `0 skip` summary.
Bun omits that line when no tests skip. It also pipes commands through tee
without preserving their exit status. Use the test command directly:

```
bun test test/sharedVaultServer.test.ts test/sharedVaultApi.test.ts test/sharedMembers.test.ts
```

## Owner-only local launch, available now

From this checkout, choose a NEW directory separate from your personal vault.
The credential file below is secret; it is outside the vault and readable only
by your account. Initialization is a one-time command, not a launch step.

```sh
umask 077
SHARED_HOME="$HOME/BigBrain-shared-playground"
mkdir -p "$SHARED_HOME"
bun bin/shared.ts init --vault "$SHARED_HOME/vault" --members "$SHARED_HOME/members.json" --owner owner --json > "$SHARED_HOME/owner-connection.json"
bun bin/shared.ts serve --vault "$SHARED_HOME/vault" --members "$SHARED_HOME/members.json"
```

The service binds to 127.0.0.1:4749. Stop with Ctrl-C; restart using just the
serve command with the same paths. No model connection, personal-vault access,
cloud account, or desktop installation change is needed. The existing desktop
app does not yet connect to this endpoint. Do not expose its unauthenticated
viewer as a shared-vault client.

## Smallest usable next slice

Keep the existing authenticated API and add a local owner client:

- Save the endpoint and owner credential securely once.
- Show connection status, current member, and owner role.
- List/search evidence and assertions with their authors and citations.
- Contribute evidence, assert a claim citing it, correct/retract own claims.
- Report authorization, validation, and server errors beside the action.
- Reconnect after restart without reinitializing or losing saved content.

Prefer a thin authenticated client over attaching the personal desktop UI to
the shared directory. This can begin as a CLI client and become a UI once the
workflow is useful. Membership administration remains on the server CLI in v0;
there are no invitation or remote-admin routes in this prototype.

## Boundaries and follow-up

The prototype has a separate sharedMembers credential implementation (`sv_`),
not the main auth.ts credential store (`bb_`). Unifying the service authorization
layer is separate architectural work; it has not already happened.

Writes preserve evidence/assertion/revocation logs plus a durable change feed.
A crash between an event write and feed append currently requires a client retry
to repair the feed; automatic reconciliation and reliable client retries need
attention before unattended use. Backups must include both vault logs and the
separate member store. Correction/retraction retry semantics also need review;
these operations reject an already revoked assertion.

Before inviting another person remotely: independent security review, TLS or a
secure tunnel, service supervision, and a tested backup/restore procedure.
Desktop integration, automatic import/export rules, model execution, portable
signatures, and centralized accounts are not prerequisites for the local owner v0.
