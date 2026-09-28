# Agent h/l navigation latency

An agent selection rebuilt the graph overlays for every conversation and eagerly
ranked connected mention suggestions. Repeated alias scans and deeply proxied
graph arrays made those traversals expensive on a large vault.

The fix:

- Keep graph responses as immutable raw Svelte state snapshots.
- Index aliases while coalescing agent chapters. Ordered node sets preserve the
  original first-match behavior when a captured chapter is removed and another
  node still owns its alias.
- Prepare the shared agent overlay in a separate derived value. Selection applies
  context styling, dormant-agent styling, inherited-edge visibility and isolation
  without repeating chapter coalescing. Graph/session updates invalidate preparation.
- Defer connected mention ranking and memory-body reads until the picker opens.
  Suggestions still update when context changes, and typed search retains its boost.
- Index titles when labeling connected suggestions.

## Current desktop integration

The initial worktree was based on experimental commit d849221, whose default
entry point still used the old UI. The fix was subsequently rebased onto current
main bc630b2, which mounts AppShell. Composer controls were preserved during the
rebase. The synthetic agent-switch browser regression, 15 focused unit tests,
Svelte checks and lint pass on this current desktop shell.

The timings below describe the older entry point; they are not measurements of
the current desktop agent-roster navigation. The current shell uses h/l to step
through the roster rather than browser history.

## Measurement

Chrome headless, Vite development build, 1440×1000. One saved local snapshot with
4,263 nodes, 11,864 edges and 63 conversations was replayed against unchanged and
modified previews. Browser API requests were mocked; no model calls or vault writes.
Six alternating h/l presses switched between the first two populated agents with
context. CPU sampling was enabled during both runs.

| Key to second frame after history change | Before | After |
| --- | --- | --- |
| Median | 302.3 ms | 48.5 ms |
| Range | 284.5–322.3 ms | 42.5–59.7 ms |

This is approximately 6.2× faster (84% less latency). It is a paint-opportunity
proxy in a development build, not physical display latency or a production p95.
The earlier investigation measured 352 ms median on a slightly older live graph.
Remaining CPU work includes canvas drawing, graph rebuilding and animation.

## Reproduce

Run each preview sequentially with the same fixture path:

```sh
PROFILE_URL=http://127.0.0.1:5200 \
PROFILE_FIXTURE=/tmp/agent-switch-fixture.json \
PROFILE_OUTPUT=/tmp/agent-switch-before \
node test/support/agentSwitchProfile.browser.cjs

PROFILE_URL=http://127.0.0.1:5219 \
PROFILE_FIXTURE=/tmp/agent-switch-fixture.json \
PROFILE_OUTPUT=/tmp/agent-switch-after \
node test/support/agentSwitchProfile.browser.cjs
```

The optional fixture contains private vault data and stays outside the repository.
Open the generated `.cpuprofile` files in Chrome DevTools.

## Validation

69 targeted tests passed across Pilot chat, migration, lifecycle, attention,
layout, context, suggestions and overlay tests. New tests cover selection reuse,
isolation, dormant styling, inherited edges, context updates and alias collisions.
An additional local differential check matched the old implementation in 400
synthetic graph/session/selection combinations.

`test/support/agentSwitch.browser.cjs` passed against the worktree: h/l history,
no mention-related memory reads during switching, and correct suggestions after
session and context changes. Svelte check, repository lint and production build
passed (the build retains its large-chunk advisory).

The older `pilotMentions.browser.cjs` fails at line 59 expecting an earlier Pilot
in the menu. It fails identically against the unchanged preview; this predates
the latency changes. Its later assertions were therefore not exercised.
