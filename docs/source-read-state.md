# Source unread state

## What is implemented

Before this change, `inbox_list` exposed live IMAP `seen` flags, but stored
sources and graph nodes had no read-state contract and BigBrain could not
change the provider's flags. The email poller's ingestion cursor is independent
of whether the user has read a message.

Read state is now a live source capability (`SourceReadState`), available through
the local HTTP API, Pilot tools, and a graph-node overlay. Gmail owns its state:
`unread: true` means the message lacks `\Seen` at Gmail; marking read/unread in
BigBrain sets/removes that flag and verifies the result with the provider.
Opening a source, agent retrieval, and gardener filing never change it.

The envelope selects unread graph nodes; the existing text tab requests an
unread-focused overview from the configured quick model (Haiku by default).
Its purpose and the current date participate in the server cache identity;
normal selection summaries keep their own cache. Shift–Enter seeds a Pilot
with the full selection (up to the 1,000-node context limit).

Text-tab mark-read/unread controls write individual stored sources in batches
of at most 100, deduplicate thread members, and report confirmed counts and
partial failures. Read state refreshes on focus, every 60 seconds while visible,
after writes, and after a Pilot finishes a turn. The workbench remains simulated.

## Integration contract

Implement `SourceReadStateAdapter` in `lib/sourceReadState.ts` and register it in
`lib/sourceReadStateApi.ts`. The adapter owns provider identity, credentials,
read semantics, and provider writes; the shared service owns source/thread
selection, serialization, caching, and per-source results.

- `supports(source)` requires a stable identity in a connected integration.
  An unsupported source has `unread: null`, not `false`.
- `read(root, sources)` returns current per-user state without marking anything
  read. `checkedAt` identifies when the provider was observed. Unavailable,
  missing, ambiguous, and unsupported state must never become “read.”
- `setUnread(root, source, unread)` sets an explicit boolean, never toggles an
  inferred value. Return success only after verifying the provider state. Change
  no unrelated flags, labels, content, or filing state.
- Adapters without write access set `writable: false` and reject writes.
  Providers with channel cursors instead of message flags must expose that
  scope honestly; do not implement a local pretend-message read flag.
- Read state is mutable operational state, not an assertion about source
  content. It is not written into source insertion events and does not trigger
  reingestion, curation, or layout changes. Restarting the service reconstructs
  it from the provider. Historical imports are not automatically unread.

The shared cache lasts up to 60 seconds. Requests refresh after expiry, and
expired flags become unknown while refreshing. Calls and writes are serialized
per vault so a pre-write fetch cannot overwrite a later change. Writes invalidate
the cache, and return individual confirmed receipts immediately. Partial batch
failure never claims that the whole selection succeeded.

Thread unread state is true if any stored member is unread, false only when
every member is known to be read, otherwise null. Changing a thread targets its
stored members once, including when individual paths overlap the selection.
It does not change unimported messages or future replies.

## Email implementation and limits

`lib/emailReadState.ts` resolves existing envelope `inbox` + `message_id` fields.
No source migration or backfill is needed. Account selection comes from configured
inboxes; credentials stay in the integration. Sources without a stable Message-ID
are unsupported. IMAP HEADER matching is substring-based, so fetched envelopes
must match the exact Message-ID before reading or writing state. Ambiguous IDs
are refused. UIDs are resolved anew while the mailbox is locked, never retained
across mailbox generations.

Gmail uses its advertised All Mail folder, which covers archived stored messages
as well as inbox mail. Other IMAP providers fall back to INBOX; missing archived
mail is unknown/missing, not read. Spam/Trash outside All Mail and unimported or
skipped messages are outside this stored-source view. It is not an account-wide
unread count. A disconnected account is unavailable.

Reads fetch headers and flags in batches, never message bodies. Writes currently
verify one message per connection; large selections should be split. Requests
accept at most 100 paths and 100 expanded messages. Provider failures are returned
without credentials or raw protocol errors. No live user mail was changed during
development; the adapter is tested against a fake IMAP client.

## API and Pilot tools

`GET /api/source/read-state` returns `{sources, scope: "stored_sources"}`. Each
row contains `path`, `title`, and `readState`. Rows include source paths and their
thread projections; consumers should select graph nodes by matching paths rather
than counting both representations as separate messages.

`POST /api/source/read-state` accepts JSON:

```json
{"paths":["log/insertions/2026-09/ins_0123456789abcdef01234567.json"],"unread":false}
```

It returns `{ok, results}` with per-message `ok`, observed `readState`, and an
error when confirmation failed. HTTP 200 can contain a partial failure. Invalid
targets are rejected before any write. JSON and same-origin browser requests
are required. The endpoint belongs to the existing loopback application server.

`GET /api/graph` overlays the latest cached `readState` on source/thread nodes
and triggers a background refresh. It never waits on email to draw the graph.
Call the read-state endpoint when the UI needs an awaited refresh; subsequent
graph responses contain the observed flags. The graph topology hash is unchanged.

Pilot, gardener, and explicitly granted MCP clients share `source_read_state`
for one granted email account. It returns read-only state with source provenance.
Pilot has no source mutation tool. Human UI actions remain a separate surface;
email must be active for either reads or human flag changes. See
[agent connections](agent-memory.md) for activation and caller grants.
