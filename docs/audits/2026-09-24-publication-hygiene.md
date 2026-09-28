# Publication hygiene review — 2026-09-24

Baseline: `origin/main` at `05ee37b05164494b2f0d101072b28cb943fa8ca8`, desktop
version 0.7.27. The repository was private during this review. This is a
cleanup and bounded audit, not clearance to change repository visibility.

## Current source cleanup

Adapted the existing, unmerged synthetic-fixture cleanup to current main.
Replaced vault-derived identity/alias examples, personal graph relationships,
worker task text, replay transcripts, private source paths and contact details
with invented examples. Kept historical benchmark measurements separate from
the new synthetic demonstrations. The worker smoke comparison now uses a
synthetic fixture instead of fetching a saved worker from a running app.

Removed the retired standalone HTML mockup with mixed personal/example content;
retained its reusable component geometry notes. Removed private-vault repository
and business-document references from old plans. Retained legitimate software
authorship, public upstream copyright notices, and product decision attribution.

Added development-data guidance for contributors and ignored local environment
variants, audit exports, temporary files and private graph previews. These rules
prevent accidental staging; they cannot sanitize existing history or screenshots.

## Scan scope and results

- Gitleaks 8.30.1, official release archive verified against its release checksum.
  Reports used `--redact=100` and stayed outside the repository.
- Scanned current tracked source, all locally reachable history, and a fresh
  remote mirror: 115 branch refs, 38 tags and 632 PR refs.
- Current source produced seven scanner candidates. Remote history produced 41:
  29 keyboard-shortcut attributes, eight test-fixture values, three extension
  public-key occurrences, and one intentionally public telemetry ingestion token.
  None was confirmed as a private credential. No network credential-validity
  probes were performed; scanner coverage is not a guarantee of absence.
- A separate keyword inventory matched 869 historical text blobs across 111
  paths. These are review candidates, including benign author/upstream credits,
  not 869 confirmed leaks. Confirmed concerns include old worker replay content,
  personal alias examples and a deleted retrieval-evaluation fixture.
- Read 944 GitHub issue/PR records and 463 issue comments; there were no review
  comments. Keyword screening flagged 44 descriptions and 14 comments. The
  GitHub text secret scan found one non-secret transcript-key example.
  Wiki and Discussions were disabled.

Detailed inventories and source exports are private local audit artifacts, not
part of this commit. No history, remote ref, issue, comment, release asset or
repository visibility was changed by the review.

## Verification

Full scratch-vault suite: 2,018 passed, zero failures. TypeScript, lint, viewer
build and Svelte checks passed. Restricted execution initially blocked local
listeners and filesystem watchers; the unrestricted scratch-vault rerun passed.

Two existing browser checks failed identically on this branch and on untouched
baseline: the legacy worker scene expects an interactive monitor now rendered as
archived, and the sidebar harness expects canvas point instrumentation that is
undefined. These are unresolved baseline checks, not passing browser validation.
Preview provenance: version 0.7.27, baseline above plus publication cleanup;
production-shell checks used `/sidebar-workbench.html` and the worker check used
the component workbench. No installed desktop or real vault was used.

## Still required before publication

Choose a publication strategy. The simpler option is a new public repository
containing the reviewed snapshot, retaining the existing repository privately
and preserving license and contributor attribution. A fresh repository avoids
carrying old blobs and GitHub discussion history into the public project; it
still needs final review of its exact contents and release artifacts.

If publishing this existing repository instead, coordinate a history rewrite
across branches and tags, handle retained PR refs and cached views, and separately
review/sanitize GitHub descriptions, comments and attachments. A cleanup commit
alone does none of that. Rotate any private credentials if a later audit finds
one; deleting a value is not revocation.

Unreviewed surfaces include binary/image contents, release assets, Actions
logs/artifacts, external attachment contents, inaccessible/deleted refs, forks and
other clones. Keyword screening is incomplete by construction; the GitHub
candidates need item-by-item review before any visibility change.
