# Granola MCP replay and revision admission

This replaces the useful replay guarantees proposed in #913 within the current
MCP/account/staging architecture (#963). It does not restore the old public API
collector or its direct-to-intake contribution wiring. Polling only stages;
explicit remembering authorization and gardener admission remain separate from
live reads. The design discussion in #913 remains historical context, not a
second implementation or permission system.

## Identity and recovery

Each account/upstream-identity/meeting has one source identity. Equality compares
its stream, meeting key, title, date, URL and discussable body, excluding receipt,
observation and supersession stamps. New staged items use a content-derived id.
A repeated observation consults existing insertion events through their rebuildable
projection, pending items, and the existing durable pass audit. A cursor is only
an optimization: losing it or `.state` does not reoffer known admitted/passed
material when the meeting is fetched again. Pending bodies and pass decisions in
`.spool` remain durable data and must not be discarded as caches.

The existing pass audit gains optional revision metadata, without copying meeting
bodies. Older pass records are recognized by their original content-derived
staged id. Corrupt recovery data fails closed rather than silently forgetting a
decision. This change does not add a separate per-source truth store.

## Ordering and admission

Granola's [MCP documentation](https://help.granola.ai/article/granola-mcp) lists
meeting identity, dates, notes and transcripts, but does not document a source
revision clock. The currently supported wire format has no verified version
ordering. Therefore `seq` records **local first-observation order**, scoped to the
account/identity/meeting. It is recovered from pending items, admitted evidence,
and pass decisions, and assigned under the projection writer lock.

Admission resolves `supersedes` against the latest admitted observation under the
same lock. A duplicate returns the original receipt. An older pending observation
cannot supersede a later admitted one; it remains pending with an error so the
gardener can pass it. Polling does not silently discard pending evidence, grant
admission, or infer source deletion. Concurrent admissions cannot create a fork.
An interruption after appending but before removing the pending item is safe to
retry.

A known old body is suppressed even if returned again after a later version.
An **unseen** stale body cannot be distinguished from an edit without authoritative
provider metadata, and is treated as a new observation. A deliberate source revert
to byte-equivalent older content is also indistinguishable from stale replay and
is suppressed. Do not present observation order as provider chronology. Reliable
provider revision metadata would be needed to support that distinction.

## Compatibility and limits

No insertion event is rewritten. Existing MCP insertions used content-dependent
source ids; new admissions continue the latest existing source id and link to its
insertion. Historical revisions already filed under other ids remain readable;
they are not retrospectively merged. Unsequenced pre-upgrade pending material is
not assumed newer than already admitted evidence. The older public-API payload
format retains its existing admission path; it is not deduplicated against MCP
payloads whose account identity and representation cannot be safely equated.

Reconnects with the same account identity preserve equality even with a new OAuth
generation. A different account or upstream identity is a separate stream.
Existing authorization/generation checks and explicit historical-import boundary
remain. Recovery does not widen that boundary, bypass the existing polling window,
add pagination, guarantee discovery of old edits, or authorize a real-vault replay.

Validation uses synthetic MCP responses and disposable vaults: pending/admitted/
passed recovery, reverse admission, concurrent retry, crash retry, unchanged
legacy bytes, old pass audit, account isolation, disabled remembering and reconnect.
No live account or credentials are required or exercised.
