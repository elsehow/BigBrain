# Local shared-vault owner v0

Standalone owner UI, based on public main 9686f88 plus the recovered
shared-vault prototype through 2be1653. It is not the installed desktop shell.

## Launch

From this checkout:

```sh
bun bin/shared-owner.ts --home "$HOME/BigBrain-shared-local" --open
```

Choose a new directory. In the browser, enter a vault name and your owner
handle, then Create vault. Add evidence; open it and Make assertion; choose
supporting evidence, then save. Assertions support correction and retraction.
Search covers evidence and live assertions; the Assertions tab also shows
retired claims and links to replacements.

Stop with Ctrl-C. Run the identical command to reopen your saved vault.
The launcher binds only to 127.0.0.1:4750 (`--port` changes it). `--open` opens
the browser with a one-use launch secret; only the public base URL is printed.
If the browser does not open, the private `launch-url` file inside the home
directory contains the link. Relaunch to get a fresh one-use link.

There is no BigBrain account or model connection required. Nothing is imported
from a personal vault. This UI writes evidence and assertions explicitly; it
does not run a gardener or create claims from pasted evidence automatically.

## Storage and authentication

The home directory contains `vault/`, `members.json`, `owner.json`,
`browser-session`, and `launch-url`. Owner/session secrets use mode 0600 and
remain outside the vault. Back up the entire home directory privately, including
`vault/.spool/` if a write was interrupted. Never publish those files.

The browser receives an HttpOnly, SameSite=Strict session cookie after redeeming
a launch secret. No member token is stored in browser storage. Mutations require
same-origin JSON; foreign Host/Origin requests are refused. Every vault request
still goes through shared-vault credential verification, so revocation takes
effect on an open UI. Local programs running as the same OS user remain trusted.

One owner interface runs per home; it shares the vault writer lock with
`bin/shared.ts serve`. Do not run both on the same vault simultaneously.
Existing owner-UI homes reopen automatically. Importing an independently
provisioned CLI vault/credential is not implemented.

## Recovery

Before writing events and feed entries, the writer atomically saves its prepared
write in `vault/.spool/shared-write.json`. A correction prepares its new assertion
and revocation together. After a process crash, the next server startup completes
that accepted write with its original actor and receive time. Identical correction
and retraction retries return the original result without adding feed entries.
This covers process-crash recovery, not a power-loss/filesystem durability promise.
Older prototype writes without a journal may still need their original retry to
repair a missing feed entry; `shared inspect` reports these gaps.

## Verified

33 targeted tests pass, covering real HTTP, two clients, restart/crash recovery,
feed resume, concurrent writes, attribution, authorization, revoked credentials,
owner-session setup, same-origin boundaries, and prepared correction recovery.
Real Chromium click-through verifies creation, evidence, cited assertions,
correction, search, retraction, server restart, safe text rendering and mobile width.

```sh
bun test test/sharedOwner.test.ts test/sharedRecovery.test.ts test/sharedVaultServer.test.ts test/sharedVaultApi.test.ts test/sharedMembers.test.ts
node test/support/sharedOwner.browser.cjs
bun run typecheck
bun run lint
```

The browser check creates only disposable synthetic vaults. The old handoff
runner incorrectly required Bun to print `0 skip`; Bun omits the line when none
skip. These commands use actual exit status rather than that text requirement.

## Next boundary

This is local-only owner operation, not a remote collaboration release. Member
management remains on the host CLI; invitation links, remote administration,
desktop workspace switching and inclusion rules remain separate work. Shared
credentials (`sv_`) have not been unified with the main client store (`bb_`).
Before remote use: independent security review, TLS/tunnel, supervision, and
backup/restore verification. Do not expose this owner UI or the unauthenticated
personal desktop viewer to the network.
