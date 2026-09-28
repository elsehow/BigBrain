# Source unread state and Pilot notifications

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

The notification center and unread toolbar are mounted in the production top bar.
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
  no unrelated flags, labels, content, filing state, or notification state.
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

## Workbench

Run `bun run web:dev` and open
`/dev.html?c=notifications&s=overview`. Add `&preview=1` for the full-window view.
Scenes cover unread/no-unread, empty notifications, busy-but-quiet Pilots,
seen unanswered questions, long messages, and sync failure. Width and dark-mode
controls belong to the existing workbench.

The bell is immediately left of Settings and uses its 40px circular styling.
The envelope and bell remain visible even when their queues are empty. The
envelope sits left of the bell and is inactive when no unread sources can be
selected. Otherwise it selects all unread graph sources. Shift–Enter opens a triage Pilot with those sources in
context. The selection uses the production NoteTab, with a fabricated Haiku
overview of decisions and background reading. A specialized unread prompt is
implemented in the production model backend; the workbench itself never calls a model. Send a message, then use
the mock mark-read action; “Change one in Gmail” simulates an external provider change.
The sync-failure control keeps the old state and shows a failed confirmation.

The dropdown follows the search surface's border, radius, shadow, row highlight,
and typography. It supports keyboard navigation, opening the referenced Pilot
message, seen state, answering, and dismissing. All are local mock
actions; refreshing resets them. Indicators use the current Pilot phase,
independent of notification intent. The runtime toggle demonstrates this. The bell count is unseen active notifications; a seen question
remains “Needs you” until answered or dismissed.

## Durable Pilot notifications

Only Pilot can create a notification through an explicit capability. Authenticate
the caller and stamp its identity server-side; a payload claiming to be a Pilot
is insufficient. Workers report to their parent Pilot and integrations update
source state. Neither creates notifications directly. Pilot/worker runtime phase
does not itself imply that the user is needed.

Notifications and their referenced assistant messages are saved together in the
existing atomic Pilot session record. There is no public notification-creation
HTTP route and neither the shared MCP tools nor worker tools include creation.
Only the bound Pilot runtime receives `notify_user` and `resolve_notification`;
it supplies the Pilot identity from the executing session, ignoring caller
identity claims. Automatic report turns may use these two tools, but still
cannot mutate mail or dispatch further work.

`notify_user({key, kind, text})` creates a conversation message and notification;
reusing a key returns the existing item, including after restart. `kind` is
`question` or `update`. `resolve_notification({id})` only resolves an item owned
by the executing Pilot, for a question answered elsewhere in the conversation
or one that has become obsolete.

Notifications persist independently of delivery. Each names its Pilot, exact
conversation/message, intent (question or update), creation time, and stable
deduplication key. Track seen, resolved, and dismissed separately.
Seeing a question does not answer it. Dismissal hides the notification without
answering the question or granting approval. “Needs you” is an explicit Pilot
request for input, never inferred from activity or an agent finishing. Refresh/restart/retry must not duplicate
notifications or lose outstanding questions. The source thread and notification
can link to one another without sharing unread/acknowledgment state.

Badges, toasts, voice, and system notifications deliver the same durable item;
delivery is not evidence that the user saw or resolved it. Answering uses the
current question identity, and any actual worker approval retains its existing
explicit user-approval checks.

The browser reads `GET /api/pilot/chat/notifications` every 1.5 seconds while
visible and on focus. POST `/api/pilot/chat/notification-state` accepts only
`{id, action: "seen" | "dismiss"}`; it cannot create or resolve requests. Changes
require JSON and the app's own browser origin. Like the other viewer endpoints,
these are served by the existing loopback host, not a new remote capability.

Opening a question targets its exact message and explicitly labels the composer
as a reply to that question; the user can cancel that association. The existing
retry-safe send request carries `notificationId`. It must identify an outstanding
question in that same Pilot. Its resolution is derived from the durably accepted
input or queued input, avoiding a separate answer/resolve transaction. Retries
retain both input and question identity; a different answer to an already
resolved question is rejected. An ordinary conversation response can also let
Pilot explicitly resolve a request. No notification acknowledgment grants a
worker approval.

The dropdown's glyph reads the current Pilot lifecycle/phase, never a status
snapshot stored with the notification. Its new badge counts unseen, outstanding,
undismissed notifications. Seen questions still need input; dismissal removes
the notification but leaves the question unanswered. Delivery here is the in-app
bell and dropdown; OS toasts and voice announcements are not added.
