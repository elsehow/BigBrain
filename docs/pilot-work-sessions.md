# Sessions as sources

Agent sessions appear in Recents and the graph. Going and waiting use colors
from the current theme. Quiet or disconnected sessions look like ordinary
nodes. Provider plus thread identity joins captured transcript segments onto
the same managed source, preserving incoming links and original source paths.

## Select, discuss, open

Every selected node has the same small surface: a title, Hold Space to talk,
and an Open action when there is an original. Assertions and worker question
forms are no longer rendered here. Pilot reads the selected record or worker
conversation to answer questions and routes instructions to the right worker.
Selection is captured at the start of each hold; background notifications never
replace an explicit selection.

Cmd-O opens a document in its reader. On a managed agent session it opens the
same provider thread in the native CLI (`codex resume ID` or
`claude --resume ID`). The button and shortcut call the same endpoint.
The session is interrupted and unsubscribed before the terminal takes ownership;
Pilot cannot send work while that CLI is open. Exiting the CLI records a private
completion receipt; the next status refresh imports history and returns ownership
to Pilot without starting a model. A failed OS launch releases ownership back to
BigBrain. A launcher can run only once. macOS uses the registered `.command`
handler; Linux uses `x-terminal-emulator`.

J/K (or arrows) inspects the selected node's first-degree connections in
salience order. Enter follows the highlighted connection. The anchor stays
selected while inspecting, so the walk remains within its direct neighbours.
`lib/graphImportance.ts` owns the score consumed by this navigation, graph depth,
and visual hierarchy: compressed connectivity with local-hub preservation,
prominence for memories, and a temporary boost for live work. Stable identity
breaks equal-score ties. Ingestion order and assertion timestamps do not rank
connections. Hover and selection animate the presentation without changing scores.

## Work and questions

`start_work` accepts `codex` or `claude-code`, a project folder, and a title.
Codex uses App Server; Claude Code uses the official Agent SDK. Both retain
provider session IDs. Claude steering interrupts and resumes; Codex steers
natively. Neither adapter starts work merely because a node is selected.

Worker questions and approvals remain durable backend requests. Codex uses
`bigbrain_ask_user` (an experimental App Server dynamic tool) plus native
approval events. Claude uses `AskUserQuestion` and SDK permission callbacks.
Pilot receives the original task and recent progress with the question so it
can explain the context. Spoken delivery waits while the user or Pilot speaks.
With voice off, in-app and supported system notifications announce the request.
No microphone opens merely to announce a worker.

Click an in-app notification to select its source, then hold Space to discuss
and reply through Pilot, or open the native CLI. `answer_work` carries the exact
pending request key; stale answers cannot resolve newer requests. Permission
approval still requires explicit user authorization. Notification claims are
persisted to prevent duplicate announcements across windows. Restart clears
abandoned live requests and leaves their nodes ordinary.

## Offline verification

`bun run test:sessions` exercises both adapters with scripted events and the
terminal launcher with a fake CLI: launch, ask, announce, answer, resume,
permission denial, stale replies, source identity, handoff, exit, and return.
No model, microphone, terminal window, or real vault is used.

`bun test test/graphImportance.test.ts test/graphDepth.test.ts test/graphHierarchy.test.ts`
checks that navigation and depth share the same salience ordering, including
activity changes and stable ties under reordered graph data.

`bun run --cwd web/ui dev --host 127.0.0.1 --port 5197`

Open `/dev.html?c=pilot&s=attention&preview=1`. Both workers wait for input;
Open in terminal or Cmd-O simulates handoff and return without opening a real
terminal. Any selected node shows the voice affordance and connection walk.
The workbench refuses real voice connections. The `work` and `quiet` scenes
compare active and ordinary session nodes.

Offline tests validate our code with simulated provider events. Audio playback
and system notification delivery still need live verification. Independently launched terminal sessions
are not monitored; unmatched historical captures open their original transcript
when available. Native CLI opening currently applies to managed session identities.

## Local app verification — 2026-09-08

An ad-hoc signed debug app built from 6a49772 ran its bundled engine against
a disposable vault and project. Both real providers asked a question, accepted
the answer, and wrote the expected file. Claude’s exact test-file write was
explicitly approved through its SDK callback. Both native terminal CLIs opened
with their saved thread IDs; stopping those test CLIs returned ownership to
Pilot and imported history. No public release or installed-app replacement
was performed.

A subsequent manual check confirmed voice works with a valid key. Native terminal
tests establish launch and ownership return, not interactive TUI behavior or
end-to-end worker-question narration.


## Conversation in the text tab — 2026-09-08

Holding Space opens Pilot in the existing text tab. Settled and streaming
turns wrap and scroll in that frame; Escape returns to browsing with the
selection intact. The graph keeps its selected anchor and Cmd-O keeps opening
that source. The global controller owns microphone and keyboard lifecycle;
there is no floating main-window HUD. The palette reuses the inline conversation.
New holds, idle disconnects, and closing the conversation do not cancel workers.

Explicit Claude Code/Codex launch requests use `start_work`, including research.
Standalone work can use an app-owned scratch workspace; edits to an existing
project still need its actual directory. The older read-only research pathway
also publishes into the ordinary session store, including recovered completed
jobs. Research follow-ups resume the same native Claude thread, and opening it
waits for the background process to stop before the restricted CLI takes over.
Its answer remains linked to its session node.

Validation: 1,709 tests passed, one skipped. Browser checks cover the inline
conversation, long replies from 390–1440px, selection preservation, keyboard and
pointer holds, Escape, Cmd-O while talking, and background-job survival. Engine
and viewer type checks, lint and production build pass. Research tests use
scripted adapters; the earlier real-provider validation is described above.


## Browsing, observation and completion — 2026-09-08

Escape again follows the normal navigation path, including deselecting an open
node. It hides the conversation without interrupting speech. Space interrupts;
a tap clears audio without submitting a new turn, while a hold records speech.
Background result announcements do not reopen the conversation or navigate away
from what the user is browsing.

Opening an active session now launches a read-only terminal observer. It never
interrupts the worker or transfers its ownership; closing that observer cannot
stop the worker either. When the session is already at rest, Open resumes the
same native CLI as before. Work started directly inside that native CLI remains
under CLI ownership until it exits. A nonzero CLI exit becomes interrupted,
not a claim that the task completed.

Completed and failed app-owned turns produce durable, once-only announcements
through the existing speech/notification queue. Busy speech delays delivery;
voice-off delivery uses notifications. Interrupted/disconnected states do not
produce a success announcement. Legacy research uses the same path, avoiding
duplicate narration. Old imported answers do not announce retroactively.

Recents now shows Added, Item, Filed by and actions; ingestion marks and their
column are removed. Graph ingestion state remains unchanged.

Validation: 1,712 tests passed, one skipped. Offline browser checks cover normal
Escape navigation while speech continues, Space interruption, live observation,
once-only completion notifications and Recents at four viewport widths.

## Follow-up reliability (2026-09-08)

A selected worker takes precedence over general research delegation. The tool
boundary refuses a new research handoff or implicit replacement start when a
session is selected. Pilot must read, steer, or answer that session; a deliberately
separate worker uses `new_session=true`. Recognized speech stays separate from
Pilot interpretation, and prompts require resolving uncertain names against the
established request rather than inventing a new research subject.

Both project-worker providers receive a named `bigbrain_current` MCP connection
on start/resume. It serves the launching vault's readers and evidence-drop tool;
every tool result includes that vault's identity. It exposes no curator tools.
The normal provider environment remains available: this is explicit task context,
not a security boundary or a restriction on all other installed integrations.
Legacy research remains read-only; read_work exposes that limitation, and Pilot
can submit user-authorized findings itself rather than pretending a draft was saved.

Completion narration uses a custom, out-of-band Realtime input containing only
the worker event, task context, and report. It distinguishes reported changes,
drafts, and blockers without answering the stale preceding user turn. This uses
[Realtime custom response context](https://developers.openai.com/api/docs/guides/realtime-conversations#create-a-custom-context-for-responses).

All current added sources now remain in the graph, including uncited, declined,
and voice records. Source-filter controls and their saved preferences are removed.
Pilot records are omitted only from Recents; they remain in the vault and graph.
Superseded source revisions continue to resolve to their current canonical record.

Validation: 1,716 tests pass, one skipped. Regression coverage includes a noisy
correction with stable worker identity, refusal of a replacement handoff, explicit
separate launches, provider connection settings, an actual MCP read/drop against
two synthetic vaults, and completion-response isolation. Browser checks cover
source visibility despite old preferences and four viewport widths. Engine
typecheck, lint, Svelte check, UI build and local desktop build pass.

Limits: offline tests establish routing and connection behavior, not speech
recognition or model compliance. A live voice correction remains the acceptance
check. Maximum permissions/folder settings are paused pending that milestone.

## Listening readiness and conversational quality (2026-09-08)

Holding Space replaces the transcript area with a large getting-ready spinner.
Only an open channel plus attached microphone produces the green "Listening —
speak now" state. Release restores the conversation. Connection lifetime is
separate from speech-turn generations: an early release and second press cannot
skip connection setup or attach a stale hold's microphone. Device attachment time
starts the minimum-hold clock. Workbench listening/connecting scenes expose both
states without a microphone.

Pilot now uses full GPT-Realtime-2.1. The prompt is rewritten around understanding,
action receipts, continuing the current worker, and explaining the meaning of
material rather than its storage representation. A conversation retains its
worker target while browsing Recents; an explicitly selected source still wins.

Manual paid model replay: `bun test/support/pilot/replay.ts <key-vault> [model]`.
It reads only the supplied API key and uses synthetic conversation data and stub
tools: no worker launches or vault reads/writes. Both mini and full made the
required send_work/read_work calls with the revised prompt; full also returned a
short clarifying question for an isolated speech fragment. Full's three replay
checks passed. This is limited text-input evidence, not an ASR or production
reliability evaluation. The full model costs more than mini.

Validation: 1,716 tests pass, one skipped; typecheck/lint/Svelte check pass.
Browser checks simulate delayed channel and microphone setup, release during
connection, a second press, one commit, microphone detach, and spinner/green
states. Local preview rebuilt with existing key and sessions preserved.

Alternative under consideration: a persistent subscription-backed Codex/Claude
Pilot with separate transcription and TTS. Compare actual correction handling,
meaning explanations, honest action receipts, and latency against full realtime.
TTS should render the Pilot's answer rather than introduce another reasoning step.
This architecture has not been implemented by this milestone.

## Text pane navigation (2026-09-08)

P opens the ongoing Pilot conversation without opening the microphone or
interrupting speech; pressing P again leaves it open. Escape leaves Pilot first, restoring the underlying
selection; the next Escape follows ordinary navigation. Editable fields keep P.
One shortcut header sits above the text pane's scrolling body for Recents,
search, selected nodes, and Pilot. Selected nodes list all first-degree
connections in `importantConnections` order; J/K highlights the same list and
Enter follows it. The redundant selection talk button and Types rail are gone.

Recents calls the provenance column Tag. Managed sessions retain the model
reported by Codex's thread response or Claude's initialization event, including
legacy handoff workers, and show it beneath the provider tag. A missing worker
model remains absent; the gardener's filing model is never substituted.

Validation: 75 focused tests pass, including both provider model paths; engine
typecheck/lint, Svelte check, and UI build pass. Browser checks cover consistent
header position/font, visible connections and keyboard following, P/Escape
preserving selection/transcript/speech, and leaving typed P alone.

## Maximum worker permissions (2026-09-08)

Settings → Vault → Pilot has an allowlist (native multi-folder picker with removable rows) and
🤠 Cowboy. Cowboy defaults off. The caption is “Agents can only read and write
within these directories.” The Cowboy tooltip is “Allow reading and writing
files system wide. Yee-haw!” Turning Cowboy on blanks/disables the list while
retaining it for later; new unrestricted workers start in the user's home.
Add directories opens the OS folder panel; each selected path has an × removal
button. Canceling or reselecting an existing folder changes nothing. A plain
browser uses an explicit Add path fallback because it cannot reveal OS paths.

`lib/workPermissions.ts` owns validation, persistence and Codex's permission
profile; `lib/workClaudePolicy.ts` translates the same ceiling to Claude's SDK.
Restricted sessions deny filesystem reads and writes outside their allowlist,
with runtime exceptions for system tools/libraries and a private per-session
scratch/temp directory. BigBrain's own permission file and session records stay
protected even if a parent is allowlisted. The explicit current-vault MCP
connection remains available for reading and dropping evidence; it does not
expose arbitrary filesystem access or settings mutations. The legacy research
reader still has only those scoped reader tools and hosted web tools.

Codex uses a named deny-root permission profile, checks the returned active
profile, and disables imported MCP servers, plugins, hooks, apps and computer/
browser tools. Claude uses OS-sandboxed Bash for file operations, omits native
file tools and imported settings/MCP, and disallows unsandboxed retries. Native
WebFetch is omitted too; shell fetches use the network sandbox. Restricted
commands cannot reach the local app API or Unix sockets. Public web access
remains enabled. Missing runtime sandbox support fails the worker closed.

Saving a changed ceiling interrupts active workers and waits for them to stop;
resuming applies the saved policy to the same thread. A worker cannot request
wider permissions through Pilot. An active native terminal must close before
settings can change. Restricted Cmd-O is always an observer, even at rest;
continue work through Pilot. Cowboy retains native CLI handoff with explicit
full-access flags. These limits do not retrofit unrelated, independently started
terminal agents.

Run `BIGBRAIN_TEST_NATIVE_PERMISSIONS=1 bun test test/workPermissionsNative.test.ts`
for actual installed Codex/Claude sandbox checks. All files are disposable;
Claude receives scripted tool calls from a fake loopback API, and Codex starts
no model turn. The checks cover allowed reads/writes, denied outside access,
symlink/volume aliases, unsandboxed retry, protected settings and local-API
access. Ordinary session tests cover revocation, reload, identity-preserving
resume, blocked escalation and terminal ownership. macOS is verified locally;
Linux still needs its own native acceptance run.

Runtime API references: [Codex permission profiles](https://learn.chatgpt.com/docs/permissions)
and [Claude sandbox settings](https://code.claude.com/docs/en/sandboxing).

## Retired research adapter boundary (2026-09-09)

The former worker runtime used provider-bound model adapters. Worker launching
has since been retired; new work runs in Pilot through the runtimes documented
in [Pilot providers](pilot-providers.md). Historical worker conversations remain
readable. The unused adapter and its tests have been removed.

## Worker visibility and research lifetime (2026-09-09)

Running sources show a themed spinner in Recents; waiting sources keep a static
marker, and quiet sources have neither. Live graph nodes keep their labels without
hover and retain foreground salience outside the selected component. Activity and
title updates preserve node identity and layout.

Research has one ten-minute inactivity watchdog, reset by actual provider stream
activity (including partial model output) and tool progress. It no longer has a
five-minute total execution limit or a duplicate timer in its child process.
Parent/process shutdown still stops the worker; an inactivity timeout is reported
as a resumable failure. Browser polling is not worker activity.

Pilot renders durable worker attention records alongside its conversation turns,
including already-announced completions/failures. The announcement flag prevents
repeated voice/OS alerts; it no longer determines whether the result is readable.
The records survive reload, and remain accessible with voice disabled. This is
separate from evidence filing and does not create a new vault insertion.

## Memory placement

Active conversations are grouped using the graph neighborhoods of their attached
notes. A source-breadth-weighted random walk starts at those attachments, excludes
the conversation's own captured chapters, and scores each memory's existing
entity neighborhood. Memory notes do not act as transit shortcuts. This creates
no entity category fields and makes no model calls. The category's `model` field
records the versioned graph classifier for compatibility with older assignments.

Classification starts after a submitted user message. Attachment changes are
debounced for 500 ms; the 30-second maintenance sweep also notices graph changes,
including during an active turn. Unchanged graph/evidence inputs reuse their saved
assignment, including after restart. Titles, drafts, streaming text and presence
heartbeats do not trigger another calculation.

Missing or tied graph evidence retains a previous category if that memory still
exists. Otherwise the conversation remains discoverable under Uncategorized
agents. A unique new graph winner can move an agent between memories; menu
selection follows that agent. Graph read failures retain the previous assignment
and back off for a minute. Graph scores are relative proximity, not confidence
probabilities; unlinked task text alone supplies no graph signal.
