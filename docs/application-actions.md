# Application action receipts

`ApplicationActions` owns durable intents and outcomes in
`.spool/application-actions/<identity-hash>.json` (mode 0600). Private Pi session
replacement, model selection and cancellation do not remove those records. The
service has one owner per desktop server; it is not a cross-process job queue.

Host adapters supply actor, logical delivery identity, operation, resource scope,
current authorization and the existing domain implementation. Arguments cannot
choose an actor. Identity is hashed separately from operation/scope/payload, so a
conflicting delivery fails. Payloads are fingerprinted rather than copied into
receipt metadata. Results stay in private records; public receipt projections
omit arguments, fingerprints and raw results.

The initial adapters cover Pilot launch/message/context reply, drop/directive and
live inbox Seen changes, desktop task follow-up, and desktop stored-source Seen
changes. Worker tool-execution receipts and vault publication receipts remain
owned by their respective domains. External MCP clients retain the existing
per-token authorization and operation paths; this does not grant them a desktop
actor or new integration capabilities.

Pilot logical actions preserve the previous identity: user input (or report set),
operation and canonical arguments. Two genuinely different user inputs are new
requests. Desktop clients attach a fresh ID per action and retain it for a network
delivery retry. Older clients without an ID are treated as new requests. A user
choosing to act again is a new request, not implicit recovery of uncertainty.

| Durable state | Meaning and retry behavior |
| --- | --- |
| prepared | Intent saved; no execution marker yet. The same request may resume after revalidation. |
| executing | Marker saved before invoking the operation. In-process duplicate deliveries join its promise. |
| completed | Confirmed return value saved. Return the receipt after checking current authority, without executing again. A completed batch can include unsuccessful item results. |
| failed | Validation, cancellation or authorization failed before dispatch. No effect occurred; do not replay this identity. |
| uncertain | Dispatch began but completion was not durably confirmed, including a process crash. Never automatically execute again. |

The executing marker deliberately creates a conservative uncertainty window even
if a crash preceded the actual external call. There is no exactly-once claim or
generic rollback. Uncertainty after launch/follow-up requires inspecting worker
history; after a contribution, inspect insertion/directive receipts; after a Seen
change, refresh the provider state. A later deliberate request has a new identity.

Stored-source batches write per-message action receipts before returning the
aggregate result. A crash after one message cannot erase that message's receipt.
Partial failures retain path and confirmation state, and uncertain items are not
silently retried. Gmail's desktop Seen-only allowance remains separate from the
agent account write policy. Integration adapters continue checking credentials,
policy and cancellation around live operations; worker project revocation still
interrupts the active sandbox. A saved receipt cannot grant execution rights.

Historical `PilotConversation.actions` entries are read-only. They remain visible
through `PilotChats.actionReceipts`; first reuse imports the old completed or
uncertain outcome into the application store without executing. New operations
never write the conversation action map. Other historical evidence stays readable.

`GET /api/pilot/chat/actions?id=…` and desktop `GET /api/actions` expose bounded
metadata projections for inspection. Pilot also receives its recent action
statuses as reference data on a fresh model session. These are observations, not
instructions or authorization.

History responses include `complete` and aggregated `issues` alongside `receipts`.
An unreadable record makes inspection partial, without blocking other records or
unrelated Pilot turns. Because its actor cannot be trusted, the issue reports no
raw contents, paths, or actor metadata. Directory failures are distinct from an
empty store. Unreadable bytes remain in place, and executing their exact identity
stays blocked, including after restart or when a historical receipt exists.
Missing results in partial history never prove that an action did not happen.

Validation includes controlled persistence failures before execution and after
an effect, concurrent delivery/conflicts, current authority on receipt reuse,
per-item partial results, forged client actor fields, and real Pilot/model-change
and restart paths. Existing provider and sandbox tests remain necessary.
