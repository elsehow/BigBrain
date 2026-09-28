# Pilot application transitions

`lib/pilotTransitions.ts` owns conversation input, turn settlement, notification,
worker-report, dormancy, and transcript-publication rules. Its inputs include time
and IDs; it performs no I/O. `PilotChats.change` persists the result before it
starts effects. The existing Pi service and worker orchestrator keep their runtime
responsibilities.

Three independent lifetimes remain explicit:

- Conversation lifecycle: active, dormant, or ingested, with explicit user
  deactivation retained separately from inactivity. Only intentional user activity
  can reopen a deactivated conversation.
- Execution: absent turn means idle; a turn has an identity and is running or
  stopping. `phase` is the existing public display outcome. A stopping turn retains
  its identity until provider work and host calls drain. A single host map holds
  each turn's controller and completion promise.
- Publication: an exact pending chapter is durable before landing. Its receipt
  settles only those bytes and that message boundary. A resumed conversation is
  not archived by an earlier chapter's completion.

| Input | Transition / effect |
| --- | --- |
| New user input | Start a turn or retain a bounded follow-up; retry by input identity |
| Stop / permission change | Mark stopping, abort, preserve queued input |
| Settlement | Accept only the owning turn; interrupted work never advances itself |
| Successful settlement | Continue queued user input before considering worker reports |
| Worker report | Preserve once by report key; deactivated/interrupted sessions do not auto-run |
| Deactivate | Abort, retain history, reject late turn output and composer resurrection |
| Restart | Clear process execution identity and expose interruption; never replay |
| Notification answer | Validate current ownership/status and retain the input identity |
| Aging | Decide dormancy, empty-draft cleanup, or publication from supplied time |
| Publication result | Match the pending chapter and preserve concurrent user activity |

`PilotChats` still owns validated file/context operations, composer leases, model
connections and storage. These resources are not state machines or new schedulers.
The former automatic-report set, unused stopping set, separate task-promise map,
and scattered phase/lifecycle transitions have been replaced. The turn identity is
additive; records without it remain readable. Public history, provider continuation,
action receipts, and realtime voice retain their distinct contracts.

Run `bun test test/pilotTransitions.test.ts test/pilotLifecycle.test.ts
test/pilotChat.test.ts` for the transition and production integration regressions.
The existing production AppShell browser suite remains the interaction check.
