# Pilot answers and live inbox state

The pilot handles conversation, navigation and simple named lookups.
Substantive knowledge questions, including finding sources about a topic,
go straight through the generic `handoff` tool, as do advice, synthesis,
prioritization, planning, research and drafting. One question uses one
retrieval agent. A simple lookup gets at most one recovery attempt before
handoff; empty search results never establish absence from the vault.
Claude Code is the first adapter; `HandoffAdapter` is the provider seam,
and tests also run a different provider without changing the lifecycle.

Both layers search the whole vault by default, preserving only restrictions
the user actually requested. `source` means connector, not caller identity;
search returns `applied_filters` to make the scope visible. Memory topic
reads, alternate search terms and entity-to-source links guide retrieval.
Empty read windows need a relaxed query or a bounded full read. Answers
must distinguish original evidence from prior agent claims, verify cited
passages, and label unread hits as leads instead of treating snippets as
proof. These are model instructions, not a guarantee of answer accuracy.

Both the pilot session and handoff worker start with a fresh memory index
(`memory/MEMORY.md`), bounded at 7,500 characters on a line boundary.
Relevant topic files are read through `load_memory` or discovered in shared
vault search, then opened with `read_note`. Memory hits are labeled derived
summaries and retain their source links. The index is labeled as record data, not
instructions or live service state.

The server builds each request from the recorded user-turn id, recognized
speech, recent conversation, executed tool evidence, current view and the
previous handoff. The pilot's task framing is separate from the person's
words. Follow-ups receive the previous full answer and provider/session
identity; they are new bounded jobs, not an interactive terminal session.

Jobs start asynchronously, with their request and session identity durable
before launch. One job per user turn makes repeated tool calls idempotent.
There are at most two active jobs and a five-minute deadline. Progress and
results are available from `/api/pilot/handoffs`; cancel uses
`/api/pilot/handoffs/cancel`. A worker watches its parent and kills its CLI
process group on shutdown. Restart exposes unfinished jobs as interrupted;
it does not silently launch them again.

The Claude adapter uses the vault's configured authentication and gardener
model selection, with a separate prompt, temporary working directory,
session and tool inventory. It has only vault readers, live inbox readers,
and web research. No shell, file-writing tools, mail mutations, gardener
tools, inherited MCP servers, hooks or user plugins. The app lands the
structured answer as `source: pilot`, `kind: handoff-answer`, agent voice.
The full sourced answer opens directly, and its `spoken_answer` goes to the
voice model for narration. It does not arrive by polling the recent feed.

Escape and barge-in invalidate pending response generations and cancel
active handoffs. Late results cannot reopen a view or trigger speech.
Escape first stops work while keeping the selection; the next press uses
normal view navigation. Previously completed answers remain openable.

Agent sessions live at the top of the existing text tab, above recents,
search results or an open note. Running jobs pin the tab open. Details
expand inline; history exposes recent completed/stopped jobs. Observe in
CLI copies a read-only transcript-follow command and does not start a
second agent. Resume in CLI is available only after stopping/completion,
and continues the same provider session with the read-only tool scope.
Terminal continuation is user-owned; it does not replace the app’s already-landed answer. No extra agent window or agent-specific page.

## Inbox scope

`capabilities` distinguishes historical vault access from live services.
`inbox_list` uses the existing configured IMAP account and reads **INBOX**,
never All Mail, for attention candidates. It reports `checked_at`, total,
coverage and UID pagination. A page is at most 50 messages; default 25.
Archived items are excluded. Neither an unread flag nor absence of an
Answered flag establishes that a response is owed.

`inbox_read` rechecks the message's INBOX UID and UIDVALIDITY. On Gmail it
also reads current inbox and sent messages in the matching thread, at most
12, to establish reply evidence. Archived received messages are excluded
in the provider query before body fetching. Sent messages are context, not
new tasks. Bodies are bounded and truncation is explicit. Mailboxes open
read-only (EXAMINE), with PEEK body fetches; no flags or labels are changed.
The ingestion cursor and gardener schedule are independent of these reads.
Calendar and direct Slack state are not connected. Forwarded Slack in the
inbox is ordinary mail.

Stored-email search uses `source=email` before the candidate limit and
returns connector metadata. `recent` calls its curation mark
`filing_status`: pending means unfiled, never unread or unanswered.
`type: source` means an original record, including emails.

## Conversations and the graph

Pilot chats follow the same gardening rule as Claude chats: three user
turns or more, last in intake priority, with only the user's side shown to
the gardener. The view labels pilot words as recognized speech. Existing
pilot segments are recognized without rewriting immutable records; the
projection rebuild brings them under the same rule. Short chats remain
searchable records. Finished handoff answers remain separate agent records.

Pilot and future named agents get their own filter identity and inherit
the agents-off default in both feed and graph. Explicit user selections
still win. Hiding a conversation does not prevent its gardening or search.

## Verification

Use a scratch vault for every write. Tests cover mixed-source filtering
before caps, owner-only gardening/replay, agent filter defaults, live inbox
read-only scope and archive exclusion, generic adapters, idempotency,
cancellation, restart, timeouts and stale realtime responses.

The private desktop harness under ignored `local_cache/pilot-session`
uses a vault snapshot, separate ports and bundle identity, disabled
background jobs, and no updater/publication path. A real Claude handoff
against a fabricated vault returned a cited answer in about 60 seconds.
Direct Gmail reads were verified separately without sending their contents
to a model. Native UI tests use simulated audio and responses to check
Escape, automatic answer opening/narration and late-result suppression.
An assistant-run handoff over real mail remains pending explicit approval
to send that mail and relevant vault context to Claude.
