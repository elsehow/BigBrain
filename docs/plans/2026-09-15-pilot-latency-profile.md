# Pilot latency: retrospective profile, 2026-09-15

Text Pilot explicitly uses GPT-5.6 Terra with **low** reasoning in both
`lib/pilotCodex.ts` and `lib/pilotResponses.ts`. The inspected session used the
Codex subscription transport; Codex's local event logs confirm model and effort.
No new model requests were made for this profile.

## Evidence

Join user/assistant timestamps in the session's spool JSON with timestamped
entries in `~/.codex/logs_2.sqlite`, opened read-only. Identify the ephemeral
Pilot process from sampling spans containing `model=gpt-5.6-terra` and a
`bb-pilot-` working directory. Count sampling starts and recorded
`codex.tool_call` durations. Do not export raw logs, headers or tool content.

| Request (local PDT) | Send to final answer | Before first sampling | Observed model rounds | Recorded tool execution |
| --- | ---: | ---: | ---: | ---: |
| 09:36, initial question | 17.58 s | 1.90 s | ≥4 | 0.77 s |
| 09:40, follow-up | 16.94 s | 4.04 s | ≥5 | 0.10 s |
| 09:53, continue | 22.37 s | 3.57 s | ≥6 | 0.31 s |
| 10:09, multi-source investigation | 47.46 s | 4.16 s | ≥8 | 0.73 s |
| 10:15, recommendation | 26.66 s | 3.90 s | ≥5 | 0.46 s |
| 10:26, follow-up | 36.36 s | 4.00 s | ≥5 | 0.33 s |
| 10:31, short clarification | 31.33 s | 4.24 s | ≥4 | 0.25 s |

These are retrospective, partial traces. Persisted logs end 2–9 seconds before
some final answers, so model-round counts and tool totals are lower bounds.
Send-to-final comes directly from the session record, not from the trace end.
Logs cannot separate network transit, service queueing, reasoning and output
sampling; do not label all residual time as model computation.

For the latest short clarification, the observed tool groups were:

- Load memory: 48 ms.
- Search vault: 191 ms.
- Read two notes: 8 ms.

Those groups finish at +6.87, +11.99 and +17.36 seconds. Between their completions
and the next calls are seconds spent in model requests; the reads themselves
are milliseconds. Another model request begins at +17.36 seconds. The trace
ends at +22.41 seconds; the answer completes at +31.33 seconds.

## Likely improvements

1. Reuse the Codex process and conversation thread across messages. Currently
   every `pilotCodex()` call starts a new process and an ephemeral thread, then
   closes both. The 3–4 seconds before sampling includes local process/config
   setup and remote initialization, not purely local overhead.
2. Preserve tool results across turns. `PilotChats.run()` passes only the last
   40 user/assistant messages; previous source reads are absent. Instructions
   also require starting with `load_memory`, leading to repeated retrieval even
   for small follow-ups. Refresh deliberately when facts or the question change.
3. Reduce separate model decisions for context housekeeping; batch independent
   reads and avoid redundant `set_context` calls. Tool speed alone will have
   little effect on these traces.
4. Add durable per-turn timings: setup, model requests, first text, tools and
   completion. This removes the uncertainty from buffered Codex logs.

No model, effort, prompt or conversation-lifecycle changes were made as part of
this retrospective investigation.

## Overview connection coverage

The inspected Pilot had three context attachments. Reconstructing
`GraphHierarchy` with `GRAPH_FOCUS` selected only the memory attachment for the
overview; both source attachments were outside it. `LinkGraph.repin()` forces
active Pilot nodes into the overview but does not force their context endpoints.
Thus one visible dashed line does not mean the Pilot used only one source.
`set_context` determines attachments; the overview filter determines visibility.
