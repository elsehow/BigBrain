# Shared Pilot and managed agents

The managed-agent design below is historical. The desktop now uses the
[Pilots-only runtime and legacy migration](pilots-only-dev.md): settled workers
become Pilots, and new worker delegation is disabled.

Pilot is a persistent assistant; typing and speaking are two interfaces to it.
Agents are independently running workers. Pilot keeps its triangular identity;
agents retain square identities after finishing. Produced vault material is a
separate source node, linked to the agent that submitted it.

## What already existed, and the problems addressed

- Voice had its own prompt, memory and tool loop. Text had a durable conversation
  but fewer capabilities. Switching input methods could change both knowledge
  and authority.
- WorkSessions already supplied durable native Claude/Codex identities,
  questions, steering, cancellation, terminal observation/ownership, and
  application-enforced filesystem limits. The new implementation reuses it.
- Text and voice did not share a worker manager. Workers lacked a durable parent
  Pilot relationship and attributable output receipts.
- Agent readiness/model menus were disconnected from dispatch. A requested model
  could be ignored on follow-up. Settings and work now share agent availability;
  each start/continuation rechecks connection consent.
- The :5198 dev UI could be restarted pointing at the installed :4747 server,
  which did not support its Pilot chat endpoints. Saved chats still existed, but
  the recents loader treated a failed request as absence. The dedicated dev
  launcher pins the proxy to :5199; loading failures now remain visible.

## Runtime

Typed input / finalized speech → PilotChats → selected backend adapter →
application tools → WorkSessions.

PilotChats owns the prompt, tool definitions, selected context, user inputs,
assistant results, action receipts, retrieved evidence, and worker event history.
Both transports receive the same application tool dispatcher and permission
checks. Realtime receives no tools or retrieved memory, never starts a response
on input commit, and speaks only a backend-confirmed answer/event. Voice's
prompt is delivery-only.

The adapter contract is in lib/pilotBackendTypes.ts; the installed factories
are in lib/pilotBackend.ts. Initial transports are Codex's subscription
app-server and OpenAI Responses. Additional providers implement that contract,
not a parallel Pilot prompt/tool/state stack.

Each session pins adapter, provider-native model and reasoning effort.
Settings → Models → Pilot sets the default for new sessions. The conversation's
Model control changes an idle session explicitly. Changing models/providers
resets provider continuation, retaining canonical messages and bounded tool
evidence. There is no automatic fallback. Unsupported setup, permissions,
models or reasoning settings fail visibly rather than substituting a model.
Voice's toggle affects speech only; text does not require voice to be enabled.

All four settings roles share ModelControls: a subscription model dropdown and
a model-specific reasoning dropdown, saved on change with visible failure and
rollback. Pilot's UI currently offers Codex subscriptions only; the Responses
adapter remains available for existing API-configured sessions, without silent
migration or fallback. Claude is not yet a Pilot backend adapter.

Reasoning travels through vault.yaml into Gardener, Memory (including trims and
folds), and Quick execution. Default preserves each role's previous behavior.
Codex options come from model/list; Claude effort capabilities come from SDK
initialization without a model turn. Haiku currently reports no adjustable
effort, so only Default is offered. Voice off hides its key controls without
removing the saved key. modelSettings.browser.cjs checks autosave, reload,
failure rollback, capability-dependent choices, and Voice disclosure on mocked
APIs; no real vault settings are changed by that test.

Model discovery follows [the official app-server model catalogue contract](https://learn.chatgpt.com/docs/app-server#list-models-modellist).

## Persistence, retries and interruption

- .spool/pilot-chats: canonical messages, stable input IDs/modes/worker targets,
  context, backend selection, pending input queue, worker events and speech
  playback receipts.
- .spool/pilot-runtime: provider continuation, bounded retrieved/tool evidence,
  API call/result pairs and a mutation intent/result ledger.
- .spool/work-sessions: worker identity, native thread, requested/reported model,
  origin Pilot/message, messages, pending questions, completion history.
- .spool/work-outputs: actual MCP drop receipts, recorded by BigBrain's tool
  server after successful submission, never inferred from agent prose.

Worker completion/failure intake sends the full saved application transcript to
Pilot directly, with no Quick model call. Each work event stores a copied
transcript through its completion cutoff, including the task, corrections,
activity and final message without additional clipping. Delivery retries reuse
that snapshot; historical pending events load it from the saved worker where
possible. Missing transcripts are explicitly labelled unavailable, with only
the receipt supplied. Duplicate receipt prefixes and inventory completion bodies
are omitted from the prompt. Questions still bypass completion processing, and
automatic reporting turns still cannot authorize new worker actions.
The Quick log/handoff experiments remain offline; see
[the comparison and decision](pilot-worker-summary-smoke.md).

Network retries reuse an input ID. Repeated transcript-finalization events
cannot append another message. Queued cross-mode input is saved before being
acknowledged; after cancellation/restart, Resume queued messages is explicit.
Mutation intents are written before dispatch. An interrupted/uncertain action is
not blindly replayed; Pilot must inspect existing results. Worker starts also
carry stable task receipts, and completion events are deduplicated by identity.

Native continuation records carry a fingerprint of Pilot instructions, tool
schemas and policy version. A missing or changed fingerprint retires the native
thread reference (keeping its ID and on-disk transcript) and rehydrates a fresh
thread from canonical history and retained evidence. The visible Pilot identity,
recency, draft, messages, pending inputs, workers, and action ledger are not
reset. An unchanged fingerprint resumes normally. The migration itself never
executes work or resubmits historical user requests. This prevents older chats
from retaining the retired read-only prompt and tool set after an upgrade.

Stopping speech cancels only audio/capture. It does not call backend Stop or
stop_work. Selecting an agent and speaking targets that worker within its parent
Pilot. Questions and permission decisions use the exact current request key;
approval cannot widen the application's configured limits. Voice approval
requires an explicit yes/allow/approve, otherwise the monitor's Allow button.

Speech receipts distinguish the generated transcript from the backend answer,
and record played versus interrupted playback. Interrupted text is not a claim
that every generated word was heard. Unsynced speech receipts are retried from
the browser's session-storage outbox. A browser crash before receiving a final
input transcript cannot recover the untranscribed audio.

## Agent UI

Selecting an @ mention immediately adds optimistic Pilot context and its graph
edge, then persists an additive update (without replacing concurrent additions).
Sending waits for these writes. Valid vault notes outside the base graph retain
their own context-node metadata; references to other Pilot sessions also link.
An older engine can use fresh-read, revision-checked context replacement until
it is safe to restart; adding out-of-graph notes requires the upgraded engine.

Worker launch snapshots the Pilot's selected nodes, bounded retained evidence
and recent conversation. Later context edits do not silently change running
work; use a follow-up to steer it. The Pilot-to-agent dotted link moves toward
the running agent, remains stationary for other states, and respects reduced
motion. The session header displays its selected model and opens the picker.

Selecting a Pilot-owned agent keeps its parent's Pilot view and labelled context
while opening the agent's tab. Standalone external agents may have no parent.
Agent headers use the same resize controls as Pilot: Shift-Up expands and
Shift-Down restores standard height. Cmd-O (Ctrl-O off macOS) opens the terminal
outside text fields. Bare h/l retain browser back/forward navigation; Esc returns
to the graph without canceling work. Shift-Esc and the close button stop an agent.

Stopping Pilot uses /api/pilot/chat/stop-tree. If any connected agents remain
(including finished turns), its header requires a second Shift-Esc or Stop click.
Cancel, other typing, navigation and changed ownership clear the confirmation.
The backend independently checks confirmation, interrupts Pilot, drains launches
already dispatched, and sends stop requests only to its owned agents. Partial
failures keep the tab open with an error. Terminal-owned agents must be stopped
in their terminal or returned to app control; the app never claims to kill an
external process. Engine shutdown and canceling a single backend turn do not use
this explicit user stop operation.

The monitor exposes reported agent/model, status, actual activity/messages,
pending questions, Stop, terminal access, task/context, follow-up input and
confirmed vault outputs. Completion remains attached to the parent Pilot even
while that Pilot is closed; it does not start a new model turn just to announce it.

agentAppearance.ts is the shared square geometry for SVG and canvas. It follows
Session views.zip → Search List States: rotating outer frame while running,
pulsing square while waiting, solid active-red square when a turn finishes, and
solid ink square when stopped; square selection frames and a cutout center for
selected running agents. Failed and disconnected states use the stopped glyph
plus explicit text.

Inspect the production indicators at:
http://127.0.0.1:5198/dev.html?c=pilot&s=agents&preview=1

Inspect the production agent chat panel together with its graph at:
http://127.0.0.1:5198/dev.html?c=agent+chat&s=running

The agent-chat workbench has starting, running, question, approval, turn-finished,
stopped, failed, terminal-owned, long-conversation and disconnected scenes.
Follow-ups, answers, permission decisions, Stop, completion and reconnect are
simulated locally. Open terminal and navigation report their intended actions;
no real terminal, model call or vault write occurs. The existing width and dark
controls apply. Add `&preview=1` for a full-window view. The browser check in
test/support/agentChatWorkbench.browser.cjs verifies these interactions,
directed-dot animation, scene switching, narrow layout and API isolation.
The `pilot-stop` scene mounts the real Pilot panel to exercise confirmation:
http://127.0.0.1:5198/dev.html?c=agent+chat&s=pilot-stop
The production HomeView regression test is agentPilotView.browser.cjs; it covers
parent context, shared resize, history navigation and confirmed stop dispatch.

## Voice model decision

Retained Realtime 2.1 for this pass. The existing WebRTC, push-to-talk and manual
response controls support a backend-owned architecture without migrating the
speech transport. GPT-Live 1's client delegation is promising but introduces a
different session/delegation protocol; changing the model is not itself parity.

Official references consulted:

- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/models/gpt-live-1
- https://developers.openai.com/api/docs/guides/realtime-conversations

## Validation and boundaries

The full test suite passed (1,971 tests, three existing live-provider tests
skipped). TypeScript, Svelte checks and the production UI build passed.
pilotShared.test.ts covers mode-independent state/evidence, duplicate inputs
and mutations, worker routing/ownership, output identities, recency on restart,
queued inputs, explicit model changes, connection consent and no fallback.
pilotShared.browser.cjs uses mocked microphone, Realtime and backend endpoints
to exercise the real browser routing, duplicate finalization, confirmed-only
playback, Stop-speech isolation and selected-worker corrections.
pilotSearch.browser.cjs covers existing search/recency/keyboard behavior.
pilotMentions.browser.cjs checks that bare @ browses recents but every typed
query searches the vault, even when a recent title also matches, alongside
stale-result cancellation, durable reference insertion, immediate context edges
before server acknowledgment, and older-engine revision-conflict retries.

No real audio quality, voice latency, or end-to-end live-model behavior was
certified by these mocked tests. Realtime speech rendering is generative;
its fidelity to backend text still needs listening tests. Worker provider
integration tests exercise the actual adapters against offline SDK/RPC peers.

Submitted output means saved intake evidence, not completed gardener filing or
entity linking. Arbitrary project files are visible through agent activity and
terminal access, but are not yet registered as durable output nodes. Historical
native threads retain their provider history; tool evidence captured before
this upgrade may not exist in the provider-independent evidence store, so a
provider switch can require re-retrieval. Worker permission questions interrupted
by an engine restart must be reissued by the provider on continuation.

Start the repeatable development pair with `bun run pilot:dev`. It starts
:5199 and Vite :5198, using the selected vault; other APIs still require the
installed app on :4747. `--backend-only` supports an already-running Vite.
It refuses occupied ports and does not kill arbitrary processes.
After switching vaults, restart this dev pair; Pilot requests fail closed while
the selected vault differs from the one the dev process opened. Do not run
workers simultaneously from the installed app's older Pilot and this dev
backend: their managers live in separate processes. The production route
manifest uses one shared manager.
