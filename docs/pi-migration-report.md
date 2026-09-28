# Pi-everywhere implementation report

Completed on 2026-09-26. BigBrain owns role authority and public work records;
embedded Pi owns model connections, private transcripts, compaction, and the
agent loop. A separate OS sandbox process enforces each worker's scope.

## Delivered sequence

1. Shared subscription onboarding and architecture: #992 and #994.
2. Responses retirement and Pi/OpenAI API-key path: #999, closing #989.
3. Pi-only Quick, memory, Gardener and Pilot with fixed tool profiles: #1000.
4. Pi core tools backed by the reusable sandbox runtime: #1001.
5. Saved project authorization, inline requests and Pi worker lifecycle: #1002.
6. Native runtime/dependency removal, smaller history/input contracts, bounded
   memory recovery, direct optional quota readings and release verification: #1004.

The existing orchestrator remains the single worker lifecycle owner; direct Pi
SDK sessions replace the two native runners. Adding a delegation plugin would
have duplicated task records, scheduling or authority. Pi core supplies tools;
`@anthropic-ai/sandbox-runtime` supplies enforcement. This sandbox library does
not require the Claude Code client or Agent SDK.

External Connected Clients/MCP and realtime voice remain separate contracts.
Old public conversations and evidence remain readable. Private native/Responses
continuations are disposable; historical effects are never replayed. Memory
recovery restores only host-observed writes whose bytes still match the run,
with citation/size gates retained and concurrent arrivals left in place.

## Verification

- Final local verification: **2,035 tests passed**, zero failures; lint, TypeScript,
  production UI build and Svelte checks passed with zero Svelte warnings.
- Production AppShell browser suite covers both subscription flows, model policy,
  quota presentation, project authorization, saved scope, access requests,
  revocation, reload and narrow layouts. Updated model/quota/worker scenarios were
  rerun after removing legacy fixtures; required macOS CI runs the entire suite.
- Real macOS and Linux containment tests exercise denied reads/writes/network,
  symlink/hard-link escapes, concurrent scopes and descendant cancellation.
- A scratch-home test installs failing `claude`/`codex` executables on PATH and
  completes setup, discovery, diagnostics, all fixed roles, Pilot continuation,
  worker editing and restart with **zero native CLI invocations**.
- Packaged macOS arm64 smoke test uses the bundled Bun, Pi SDK, sandbox helper,
  write/bash/find tools and bundled ripgrep against synthetic files. No installed
  app or real vault is used. Package provenance: engine `3d13bd25`, built
  `2026-09-26T23:50:36Z`; version 0.7.28. The final report/formatting commit does
  not change executable behavior. Preview checks use production AppShell through
  `/sidebar-workbench.html`, with the Pi cleanup changes atop main `6e6b99a1`.
- Live Pi Claude OAuth profile/quota endpoint shapes were verified without
  recording credentials or account details. Inference/tool regression tests use
  scripted responses at the actual Pi SDK boundary.

Full testing also reproduced an existing projection-lock race. Independent #1003
replaces the partially published PID-directory lock with a crash-released SQLite
transaction. Its 240 repeated checks include concurrent admission, eight competing
writers, nested exceptions and forced owner termination. It is excluded from the
migration source-line totals below.

## Measured change

Baseline: `bedf326f`, before #992/#994 and this six-step sequence. Code endpoint:
`3d13bd25`. Line counts include comments and replacement code; they are physical
source lines, not a claim that all remaining complexity is gone.

| Area | Added | Removed | Net |
| --- | ---: | ---: | ---: |
| Production (`bin`, `lib`, `web/ui/src`) | 1,208 | 3,473 | −2,265 |
| Tests and fixtures (`test`) | 959 | 2,100 | −1,141 |

Both resource bundles were assembled with the same build script and Bun 1.3.9 on
macOS arm64, using each revision's pinned dependencies. These are sums of regular
file bytes excluding symlinks, not compressed installer sizes or filesystem block
allocation. The Bun sidecar is unchanged.

| Resource | Before | After | Change |
| --- | ---: | ---: | ---: |
| Engine bundle | 402,765,329 B | 208,142,422 B | −48.3% |
| Production dependency files | 398,250,373 B | 203,751,770 B | −48.8% |
| Direct runtime dependencies | 13 | 14 | +1 |
| Installed top-level/scoped dependency packages | 258 | 262 | +4 |

The Agent SDK leaves; pinned sandbox-runtime and ripgrep enter. Package count
increases slightly while native runtime code and bundled bytes decrease sharply.
Linux containment is exercised in CI; a Linux desktop installer was not built.

See [model/runtime behavior](pilot-providers.md), [project authorization](project-workers.md),
and [accounting](provider-accounting.md) for the maintained product contracts.
