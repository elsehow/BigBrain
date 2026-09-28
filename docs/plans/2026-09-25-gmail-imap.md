# Gmail IMAP implementation and review

Baseline: origin/main `18f92906`, desktop version 0.7.28. Installed desktop
reported engine `565de2ec`; this work does not install or change it.

Gmail uses the existing `email` identity, account policy, integration tools,
staging, gardener admission and evidence log. Its library card and account UI
are the same production components as Granola. The necessary difference is an
app-password form. No Google MCP or public OAuth dependency is introduced.

## Behavior

- New Gmail accounts are marked `provider: gmail`, with TLS to imap.gmail.com:993.
  Connection checks authenticate and EXAMINE All Mail without fetching content.
  The app-password input is write-only; the vault's existing private .env store
  holds it. Initial connection enables neither live access nor remembering.
- Gmail writes are refused in shared tool authorization, direct inbox operations,
  and the stored-source read-state adapter. Existing email accounts keep their
  policy, credentials and write grants. New Gmail setup refuses an existing
  account or a colliding legacy credential key rather than converting it.
- Remembering starts at connection time, requires a rule, and names the current
  destination vault. Earlier history is opt-in. Whole messages are staged for
  gardener review; this is local retention before admission. Gmail attachment
  retention is off unless selected. Existing legacy email attachment behavior
  is unchanged. Live access never stages or admits mail.
- Gmail identities use account + X-GM-MSGID, preserving 64-bit values as strings.
  Thread IDs and labels are provenance, not message identity. Generic IMAP's
  missing-Message-ID fallback includes mailbox and UIDVALIDITY. Existing admitted
  or pending legacy evidence is recognized using account, Message-ID and exact
  discussable body, without rewriting evidence. The insertion and pass logs plus
  pending items supply discovery outcomes; there is no parallel email memory DB.
- Backfills advance only through the processed batch. New accounts retain their
  consented start date and replay from it on UIDVALIDITY/mailbox reset, deduping
  prior outcomes. Headers and bodies that fail remain durable retry work, with
  status in setup; three attempts no longer discard a message. The poller opens
  mailboxes read-only; ImapFlow issues PEEK fetches.
- email_search reads Gmail All Mail with bounded header pages. email_read and
  inbox_read return 12-message thread pages including sent and archived context.
  Cursors report UIDVALIDITY; stale message refs and archive/thread cursors fail.
  Account grants and revocation apply to Pilot, gardener and MCP, including text
  Pilot's reader allowlist. Inbox status and reply obligations remain separate.

## Deliberate limits / release gates

No live Gmail or Workspace account has been tested. Eligible app-password users
only; All Mail must be exposed through IMAP. The credential grants broad provider
access even though BigBrain enforces read-only operations. OAuth, public Google
verification, sending, mailbox mutation, release and deployment are out of scope.

All Mail coverage excludes spam/trash and remains subject to server IMAP limits.
Live bodies are capped at 128 KiB/18,000 text characters and disclose truncation.
Discovery is an arrival feed, not a mailbox mirror: later flags/labels/deletions do
not rewrite old evidence. Large messages (>25 MiB) remain failed/pending rather
than being downloaded. Selected attachments retain the existing 10 MiB total cap.

Old checkpoints lacking a historical consent boundary require an explicit
`--since` recovery after UIDVALIDITY changes; the runner fails visibly instead of
silently jumping to now or importing an unauthorized full history. Old pass logs
without account/provider identity may be reconsidered on an explicit replay;
new passes dedupe by account-scoped provider identity. A future recovery UI for
legacy accounts is separate from this new Gmail setup flow.

## Validation and preview

Tests exercise actual runner initialization in a child process with a disposable
vault, controlled IMAP results, and also real ImapFlow against a local wire server.
Cases cover >5,000 discovery results, UID reuse/reset, duplicate/missing RFC IDs,
legacy matching, independent accounts/policies, delayed retries, .state deletion,
attachment defaults/opt-in, read-only enforcement and live no-retention.

`test/support/gmail.browser.cjs` drives Gmail and Granola through production
AppShell in `/sidebar-workbench.html?gmail#/integrations`, checks independent
choices and desktop/mobile layout, and verifies fixture credential requests never
reach the network. Fixtures retain no passwords and do not call a provider.

Run relevant tests with `bun test test/gmail.test.ts test/gmailProtocol.test.ts`
and the existing email/integration/access/stage/read-state suites. The protocol
suite requires a localhost socket. Run the browser script with
`SIDEBAR_PREVIEW_URL=http://127.0.0.1:<port> node test/support/gmail.browser.cjs`.

## Google requirements checked 2026-09-25

- [App passwords](https://support.google.com/accounts/answer/185833): require
  2-Step Verification; account eligibility and administrator restrictions apply.
- [IMAP OAuth](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol):
  full mail scope and verification apply; this is not a verification shortcut.
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes):
  gmail.readonly is narrower but still restricted; assess actual model-provider
  data transmission before a public OAuth release.
- [Workspace preview](https://developers.google.com/workspace/preview): Gmail MCP
  remains preview, with enrollment and public-application restrictions.

Validation result: full suite 2,030 pass / 1 failure. The failing
`test/webRouteGuard.test.ts` server-startup check also fails on unchanged
`18f92906`. TypeScript, lint, Svelte checks and production UI build pass
(the build reports its existing bundle-size advisory). Production-shell browser
checks pass. No real mailbox or model-provider validation was performed.
