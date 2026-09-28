# Persistent text Pilot runtime

Implemented on `feature/pilot-session-views` following the [latency investigation](2026-09-15-pilot-latency-profile.md).

The previous runtime created an ephemeral Codex process/thread for every message, replayed only the visible conversation, and discarded previous tool results. Even simple follow-ups repeated memory/search/read cycles. Pilot now owns a persistent provider conversation.

## Subscription transport

- Starting/opening a Pilot schedules authentication/configuration warmup after returning the UI response. Warmup does not run inference or create a stored empty thread. Typing and message queuing remain independent of it.
- The first message creates a persistent Codex thread with the same Terra model, low reasoning, managed subscription credentials, restricted permissions, and reader/context tools.
- Later messages append only new messages plus current view state and changed main memory. Previous tool evidence remains in the provider thread. After an engine restart, idle cleanup, or explicit close, `thread/resume` restores it.
- Interrupt calls `turn/interrupt` and waits for completion, preserving the thread. If interruption fails or is not acknowledged within three seconds, the process closes; the next message can resume the saved thread. An uncertain dispatched turn never falls back to a second paid API generation.
- At most four processes stay warm. Idle processes can be evicted to make room; ten minutes without a turn releases one even if the composer remains open. Explicit deactivation and engine shutdown also release processes. Thread identity survives cleanup. The existing UI Escape/Shift-Escape behavior is unchanged.
- Sessions created before this change have no retained provider thread/tool history. Their next message establishes it from the visible conversation; subsequent messages benefit from reuse.

## Context and API fallback

The backend supplies `memory/MEMORY.md` directly, checks it on each message, and supplies changes without asking the model to make a tool call. Topic memory and note readers remain available. The prompt encourages reusing already-read evidence and rereading when freshness matters. There is no tool-result cache that silently serves an old version of a newly requested note.

The prompt no longer mandates `load_memory` on every turn or unnecessary `set_context` calls. Identical context/title updates are no-ops. Independent API reader calls execute in batches of up to four; context mutations remain ordered. Subscription tool requests have the same concurrency limit.

API fallback keeps complete conversation turns locally, including tool call/result pairs and encrypted reasoning, while retaining `store: false`. It reuses these across messages and restarts. Once API history owns a conversation it stays on that transport, avoiding divergent provider histories. Old API turns are pruned whole at the configured history budget; the most recent turn is always retained. Interrupted batches never persist dangling tool calls.

Provider state lives in `.spool/pilot-runtime/<pilot-id>.json` with mode 0600, outside the browser's polling payload. Subscription history is managed by Codex's persisted thread storage. Empty draft cancellation creates no stored thread. Closing a nonempty Pilot preserves its conversation.

## Timing and configuration

Runtime limits, reasoning, idle timeout, turn timeout, interrupt grace, concurrency, history size, and stream-save interval are together in [`lib/pilotRuntimeConfig.ts`](../../lib/pilotRuntimeConfig.ts). Product dormancy/ingestion timings remain in [`lib/pilotLifecycleConfig.ts`](../../lib/pilotLifecycleConfig.ts).

Every new turn records a small 0600 file at `.spool/pilot-timings/<pilot-id>/<message-id>.json`:

- setup through dispatch, first visible text, completion, outcome, and transport;
- each tool's start/end (names only, no arguments, prompt text, or result bodies);
- API request start/end and usage, or subscription token usage when emitted.

Run `bun bin/profile-pilot.ts` for the latest profiled session, or `bun bin/profile-pilot.ts pilot-…` for a specific one. Tool wall time takes the union of overlapping spans. Subscription app-server does not expose individual sampling requests through this interface, so the report does not invent a model-round count or attribute all remaining time to inference. Network, upstream scheduling, reasoning, and output generation remain combined in that remainder. Historical turns before instrumentation cannot be reconstructed from these files.

## Validation

Real subscription smoke test, same Terra/low settings, synthetic note with a unique fact:

| Turn | Setup to dispatch | First text | Complete | Tool calls |
| --- | ---: | ---: | ---: | ---: |
| Cold, read note | 0.077 s | 13.15 s | 13.31 s | 1 |
| Warm follow-up | <0.001 s | 4.86 s | 5.05 s | 0 |
| Reconnect and resume | 0.068 s | 6.47 s | 6.65 s | 0 |

All three returned the correct fact. The persisted test thread was deleted afterward. This is a small functional/performance check, not a representative latency distribution or a like-for-like comparison with the historical multi-source research requests. The historical time before first sampling also included provider work, not just local setup.

A cold HTTP smoke test through `:5198` also found an unnecessary whole-graph load for empty context. Skipping it reduced empty-session backend create from 2,578 ms to 1.6 ms; discard took 1.8 ms. Existing sessions were preserved. These are backend HTTP timings, not browser paint timings.

Automated coverage includes connection reuse, resumption, abort before turn acknowledgement, no replay after dispatch failure, no orphan thread from canceled warmup, bounded warm processes, changed memory, API tool/reasoning retention across restart, bounded parallel reads, ordered/no-op context changes, complete-turn pruning, interruption history integrity, and private timing records. The existing browser Pilot suite verifies optimistic creation/queuing, line motion, immediate Escape, Shift-Escape interrupt/stop, cancellation, and deactivation.
