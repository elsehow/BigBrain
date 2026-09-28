# Pilot sessions own their graph view

Implemented in the main graph and text drawer. The `pilot` workbench group keeps
the deterministic visual fixture; previous previews remain under `pilot (legacy)`.

## Interaction

Shift-Enter captures the explicit graph selection as the new session's seed and
current context, selects its node, moves the camera, and focuses its composer
immediately. A client-generated stable ID is persisted in the background with
idempotent creation. Typing and queuing a message do not wait for connection;
the queued message appears immediately and sends after persistence succeeds.
An empty seed shows the agent alone. Enter sends; Shift-Enter inside a session
inserts a newline. There is no nested session action or Save view button.

Active sessions have dashed edges flowing toward the session, independently of
selection. Working sessions also have a spinner. Downward triangles identify
Pilots across the graph, text tab and search; closed sessions retain the triangle
in neutral ink. New drafts use a hollow triangle with a blinking caret.
Answers fill the core rust red and leave the composer focused. Outer selectors
mean selection; the text tab displays only the status core, except for its working
spinner. `SELECTOR_RATIO` is the golden ratio, exposed as a renderer parameter.
Edges stop at outer selectors, including memory diamonds.

The graph caption is only **Pilot view + session name**. The text tab's Context
control lists the actual attachments and allows removal. A single original seed
keeps its name plus the additional count while it remains attached. Multiple
original seeds use a plain total count, including after agent changes.

Navigating away or pressing Esc discards an empty unsent draft. Typed drafts
remain as Draft session and restore their text when reopened. Esc dismisses the
view immediately, clears all graph selection, and leaves generation running.
Shift-Esc interrupts a working turn in place; when no turn is working, it stops
the session and preserves its node and conversation. The shortcut bar says
**Shift-Esc Interrupt** or **Shift-Esc Stop** accordingly. X stops the session
explicitly. Key repeat cannot turn an interrupt into an accidental stop. Cleanup
failures appear in a dismissible top-right toast. A queued message interrupted
before dispatch remains an unsent draft. Background replies do not take over a
different selection.

## Runtime and persistence

- `lib/pilotChat.ts` owns bounded text turns, persistence and context validation.
  Each session is an atomic JSON record under the host spool's `pilot-chats/`,
  with stable ID, immutable seed, replaceable context, title, messages, draft,
  status and revisions. In-flight turns become interrupted after restart.
- `lib/pilotChatRoutes.ts` exposes list/create/presence/draft/discard/send/stop/context/check
  through the desktop route manifest. The frontend polls at 300 ms while working
  and 1.5 seconds otherwise. Credentials never reach the browser.
- `lib/pilotCodex.ts` first tries the user's managed ChatGPT sign-in through
  Codex App Server. It requires GPT-5.6 Terra with model fallback disabled, uses
  an ephemeral scratch thread, and disables inherited shell, writing, spawning,
  MCP, plugin and other agent capabilities. Only the supplied context tools run.
- If subscription setup is unavailable before a turn starts,
  `lib/pilotResponses.ts` uses the saved OpenAI API key with `gpt-5.6-terra`,
  streaming Responses, low reasoning, and `store: false`. An already-started
  subscription turn never silently replays against the API. Settings' connection
  test reports the chosen transport; the session title's tooltip also identifies it.
- Session history is stored locally; each turn sends the most recent 40 messages
  and its current context. Within a Responses turn, tool outputs and encrypted
  reasoning are preserved. Turns have a three-minute timeout, four concurrent
  sessions maximum, and bounded tool calls/output. Interruption blocks late updates.
- Tools: `load_memory`, `search_vault`, `read_note`, `recent`, `inbox_list`,
  `inbox_read`, `set_context`. No voice, note writing, sending, or worker spawning.
  `set_context` validates canonical IDs/aliases, replaces up to 50 members, sets
  the title, and checks a separate view revision before applying the change.
- `web/ui/src/lib/pilotChatGraph.ts` projects sessions and directed attachments
  into the production canvas graph. The session record owns membership; camera
  coordinates remain local. Context updates affect the view only while its
  session is selected. The active empty-context view contains only the agent.

## Dormancy and ingestion

**Edit all lifecycle durations in `lib/pilotLifecycleConfig.ts`.**

After **10 minutes** without user or agent
activity, show an idle session as a neutral dormant node; after **24 hours** idle,
ingest new transcript messages through normal evidence intake. Working turns,
unsent drafts, and open composers are exempt. Maintenance runs every 30 seconds
and on server startup, even without a browser connected.

`lastActivityAt` records user/agent activity separately from saves and polling.
Composer tabs renew independent leases every 15 seconds, expiring after 90 seconds
if disconnected. The expiry is persisted across engine restarts. Heartbeats
extend protection without resetting the activity timestamp; explicit reopening,
closing, typing, context changes and completed turns count as activity.

Each immutable chapter is persisted before landing, including its exact bytes.
A lost receipt retries the same payload and deduplicates through normal intake.
The receipt records the message boundary; future chapters contain only new
messages. Session identity, original seed and current view are in the source
metadata. The graph coalesces all chapters into the original session node,
retains source aliases, and draws dormant/ingested sessions as neutral triangles. Reopening restores its live view and allows another turn. A late ingestion
receipt cannot deactivate a resumed session. Failed ingestion preserves the
transcript and retries automatically.

## Search and Recent

Focusing the search bar includes persisted and optimistic Pilot sessions before
ingestion. Their date is semantic activity, not heartbeat or ingestion time.
Search matches the session title, draft and transcript, alongside vault results;
ingested chapters coalesce into one session row. Opening it restores the existing
conversation and its owned context. The shared glyph, tag and date occupy separate
columns. Search Escape dismisses only the dropdown.

## Validation

Unit coverage includes canonical seed identity, context replacement and conflicts,
durable drafts, repeated turns, cancellation and late tools, reader allowlists,
SSE chunk boundaries and incomplete streams, model selection, subscription
fallback boundaries and restricted Codex configuration. The route inventory covers
the new endpoints.

Browser checks cover actual graph/composer wiring, multiple seed items, multiline
draft retention and reopening, streaming phases, citations, restored history,
Esc deselection, Shift-Esc interruption/stopping, empty context and focus. Live synthetic tests verify Terra via
both Responses and Codex subscription, including search/read and context updates.

`test/pilotLifecycle.test.ts` advances a fake clock through both deadlines,
multiple composer leases, restart/crash recovery, incremental landing and
ingestion/resume races. `test/support/pilotSession.browser.cjs` delays backend
connection and forces cleanup failure to verify immediate UI feedback, queued
messages, cancellation, draft retention and the error toast.
