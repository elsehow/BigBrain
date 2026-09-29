# Shared vault in the BigBrain shell

This experiment uses the production `AppShell.svelte`: the existing graph,
recents, search, note reader, typography, and keyboard navigation. It is based
on public main `9686f88`, plus the recovered shared-vault server and owner work.
It does not replace or modify an installed desktop app. The checked-out public
main reference is seven commits newer (`96c3da5`); those unrelated fixes are not
included in this continuing experiment.

## Try it locally

Build the viewer once (`bun run web:build`), then double-click
`Open Shared Vault.command`, or run:

```sh
bun bin/shared-shell.ts --home "$HOME/Projects/bigbrain-shared-local" --open
```

The launcher reuses an existing owner-preview directory. For a new directory,
it creates a shared vault with your OS username as owner; `--owner` and `--name`
can override those defaults. It refuses to overwrite an existing vault that
has no saved owner credential. Stop the earlier standalone owner interface
before opening the same directory here: both use the same writer lock.

The viewer runs at localhost:4768, the authenticated shared server at
localhost:4769. `--port` and `--shared-port` change these. The printed URL and
`shell-launch-url` open the shared workspace. Ctrl-C stops both services;
rerunning reopens the same records.

The Personal vault entry in this preview points at `preview-personal/`, an
isolated empty directory. It does **not** point at your real personal vault.
No supervisor, gardener, or model session is launched.

## Use it

- The vault-name menu switches between personal and saved shared connections.
  Connect shared vault accepts a name, server origin, and member credential.
- Search and Recents (`/` and `r`) work as usual. Open a record to read its text
  and follow its connections.
- Add evidence contributes title/text explicitly. Text/Markdown file drops also
  work; binary attachments are rejected with an explanation.
- Open evidence to assert a claim, correct your own assertion, or retract it.
  `[[Entity name]]` links form the familiar graph. Correction retains citations.
- The menu shows the authenticated member, owner/member role, and read/write
  permission. Read-only members can browse; write controls are hidden and the
  server separately rejects writes. Revoked/offline connections hide the vault
  and show a reconnect screen.

Pilot, model-generated briefings, personal settings, provider read/unread state,
and automatic sharing are unavailable in shared mode. Membership and owner
moderation remain in `bin/shared.ts`; the separate owner dashboard remains a
backend harness, not the product interface.

## Authentication and isolation

The local viewer retains its existing loopback/same-origin trust boundary. It
holds member credentials in a mode-0600 file **outside** the vault and forwards
requests to the authenticated shared API. Credentials are never returned to the
browser or put in browser storage. HTTPS is required for remote origins; HTTP
is allowed only on loopback, and authenticated requests never follow redirects.

Normal operation uses `~/.config/bigbrain/shared-connections.json`;
`BIGBRAIN_SHARED_CONNECTIONS` overrides it. The preview keeps a separate
`shell-connections.json` beside `owner.json` and `members.json`. These are private
local files, not vault content or an OS-keychain integration.

One document belongs to one workspace. Switching replaces the document, resets
selection/drafts/Pilot state, and isolates caches. Shared response payloads are
not persisted to browser storage. Every shared request is routed before the
personal handlers; an unknown shared action fails closed. Connecting does not
import or publish personal content. Local programs running as your OS user are
trusted, as in the existing viewer.

## Recovery and tests

The shared server journals prepared writes in `vault/.spool/shared-write.json`.
Startup completes interrupted accepted writes with the original actor and
receive time. Identical retries deduplicate. This covers process crashes, not
power-loss durability. Back up the entire owner directory privately, including
`.spool/` and credentials.

```sh
bun test test/sharedWorkspace.test.ts test/sharedMembers.test.ts test/sharedVaultApi.test.ts test/sharedRecovery.test.ts test/sharedVaultServer.test.ts test/sharedOwner.test.ts test/vaultBoundary.test.ts test/httpx.test.ts test/env.test.ts
node test/support/sharedWorkspace.browser.cjs
bun run lint
bun run typecheck
bun run --cwd web/ui check
bun run web:build
```

The browser regression uses the production shell and disposable synthetic
personal/shared vaults. It covers connecting, identity, evidence, assertions,
correction, recents, switching, read-only access, revocation, and credential
storage. The adapter reads paginated metadata into memory; search uses the
shared server's current 50-hit cap. It is a small-vault v0, not a large-vault
incremental sync implementation.

Remote hosting, invitation links, membership administration in the UI, a unified
`bb_`/`sv_` credential scheme, and inclusion rules remain separate work. The
local viewer itself must remain loopback-only.
