> **SUPERSEDED (2026-08-23, #497):** the attestation layer was deleted — the ontology-free assertion log won. Kept as history.

# Attestation-first retrieval experiment

This pilot tests whether attributed attestations can replace reference and
entity files as retrieval primitives. Its projection tools are intentionally
parallel to the current product and write nothing back into a vault.

## Boundary

`attestation-pilot import` is a one-time backfill path for vaults created before
native insertion events. It is the only operation allowed to read
`references/`, and it never reads `entities/`. New-vault operations read
`log/insertions/` directly.

Every later operation consumes only:

- the insertion log;
- the append-only attributed attestation log; and
- disposable projections built from those logs.

Deleting or denying access to the old vault after import must not change the
result. The test suite exercises that condition directly.

## Native landing

New non-request drops write `log/insertions/<month>/<event-id>.json`
before writing `references/`. Each event id is deterministic over source id
and the exact landed envelope/body, so retries converge. The event and today's
reference compatibility projection ride the same intake commit. Models receive `log/`
read-only; only host code may append provenance. Once remaining readers move
to insertion projections, the compatibility reference write can be removed.
The emitter, attributed assertion boundary, enrichment pass, and projector all
accept `--vault` and read this log without touching `references/`. The tenant's
stable account id and identity labels are projection policy supplied by the
control plane; they are not fabricated from source content.

Native assertions are one immutable JSON event each under
`log/attestations/<month>/`. Deterministic emission may replay the complete
source log after every batch: existing event ids converge byte-for-byte and
only facts from new insertions append. User and delegated-model assertions use
the same host boundary after evidence and authorship validation. Each batch is
a partial Git commit containing only new attestation events; edits or deletions
cannot ride it.

## Attestation shape

An attestation has a subject, predicate, object, author principal, confidence,
extractor/version, creation time, and optional exact source evidence. Authors
are stable `user`, `model`, `service`, `agent`, or `system` principals. Model
authors additionally retain their exact model and invocation identity.

The deterministic emitter owns system/service assertions. The external append
boundary accepts only the known vault owner or a model delegated by that owner.
Model assertions require an exact quote verified against the insertion log;
they remain candidates until the owner explicitly endorses them.
The deterministic pass emits only mechanically declared envelope facts. It
does not treat capitalized body text as people; body mentions and missing
participants require an attributed model pass.

The first predicate vocabulary is deliberately small:

```text
participated_in  mentioned_in  authored_by  submitted
has_work_context  same_identity_as
endorses  disputes  supersedes
```

User endorsement, dispute, and supersession are themselves appended
attestations. The assertion they address remains in history.

## Run

```sh
# Native path: source log -> attestations -> disposable query projection.
bun bin/attestation-pilot.ts emit \
  --vault /path/to/vault --user-account usr_demo \
  --user-label "Alex Rowan" --user-label alex@example.com

bun bin/attestation-pilot.ts project \
  --vault /path/to/vault --user-account usr_demo \
  --user-label "Alex Rowan" --user-label alex@example.com \
  --out /tmp/projection

# Legacy backfill only: references -> frozen insertion snapshot. Any command
# may use --insertions /tmp/legacy-insertions instead of the native flags.
bun bin/attestation-pilot.ts import \
  --vault /path/to/legacy-vault --out /tmp/legacy-insertions \
  --user-account usr_demo --user-label "Alex Rowan" --user-label alex@example.com

bun bin/attestation-pilot.ts emit \
  --insertions /tmp/legacy-insertions --out /tmp/legacy-attestations

# Optional ambiguous-body pass. It reads the insertion log, never the vault;
# every model claim is candidate-only and carries a verified source quote.
bun bin/attestation-enrich.ts \
  --vault /path/to/vault --user-account usr_demo \
  --user-label "Alex Rowan" --user-label alex@example.com \
  --out /tmp/enrichment-run --term interpretability

# Optional semantic projection uses the same generic chunk embedder.
bun bin/retrieval-embed.ts --index /tmp/projection --out /tmp/semantic

bun bin/attestation-pilot.ts query \
  --mode people --projection /tmp/projection --semantic /tmp/semantic interpretability
```

`assert` appends a source-verified user/model assertion. The projector applies
authorship policy: declared system/service participation is direct; model
participation remains candidate; a user endorsement promotes it; and a user
dispute remains visible without erasing the original assertion.
