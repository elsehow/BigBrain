# Application views and updates

Pilot summaries/details and worker summaries/details are allowlisted projections
in `pilotChatSummary.ts` and `workViews.ts`. HTTP never serializes a worker or
Pilot record directly. Nested messages, image references, notifications, grants
and operation receipts have their own projections. Grants shown for an explicit
user decision are public; runtime ceilings, provider history and tool arguments
are not. Graph activity uses these same summaries, not a second stored model.

Each successful application save increments its entity revision and schedules an
invalidation. The existing SSE connection carries `application` events with a
process epoch, consecutive batch revision, and changed entity IDs/revisions.
Streaming saves coalesce for 100 ms. No transcripts or policy records travel in
these events. The stream is ephemeral, not an event log or a durable queue.

Every connection starts with a snapshot instruction. Epoch changes and batch gaps
also require a full list refresh. Duplicate/out-of-order batches within an epoch
are ignored. HTTP results crossing an epoch change are rejected, and entity
revisions prevent older detail/list responses overwriting newer state. Invalidations
arriving during a request are drained afterward, rather than sharing and losing
the last in-flight refresh. The existing fallback polling remains for old servers,
offline streams and fixtures without application events.

The attention owner fetches affected Pilot/task summaries by ID. Open task panels
subscribe independently to their own identity. Notifications derive from Pilot
views. Browser draft text, optimistic inputs, selection and discarded identities
remain browser-owned. Summary replacement preserves only explicitly loaded detail;
a removed optional summary field must not survive by accidental object spreading.

Application activity does not increment vault content revision. Filesystem watching
still reconciles external vault edits, search projections and graph topology.
Source read-state refresh retains its provider reconciliation cadence and focus
refresh. Actual publication to the vault still triggers content invalidation.

The production AppShell browser test opens two fabricated views. In a 3.2-second
healthy idle window it observes zero application list/notification requests
(previous visible idle polling made about two list refreshes, four requests, in
that interval). One task event makes one task-list request and zero graph requests
or vault revision changes. Gap/restart snapshots retain unsent drafts. These
counts exclude provider read-state reconciliation and composer leases.
