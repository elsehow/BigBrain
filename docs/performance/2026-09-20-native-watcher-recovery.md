# Native progress watcher recovery — 2026-09-20

Investigation and fix for [#865](https://github.com/elsehow/BigBrain/issues/865).

The Linux timeout was a real notification failure. During recursive watcher
registration, Bun 1.3.9 sometimes tried to open/watch an atomic-write temporary
file after its rename. It emitted `ENOENT`, then delivered no change paths for
the rest of the two-second test, despite 77–79 publication attempts and
valid progress on disk. The application swallowed this error under the old
assumption that a disappearing file was harmless to the watcher.

## Reproduction

The diagnostic checkpoint `9a6eee5` retains main's watcher behavior and adds
received paths, errors, publication counts, and readable status to timeout
failures. It also repeats the native integration test on GitHub's Linux runner.

```sh
bun test test/gardenerProgress.test.ts \
  --test-name-pattern 'the real filesystem watcher' --rerun-each 100
```

Each trial creates a scratch vault and a live gardener lock, starts the real
recursive filesystem watcher, and publishes atomic progress updates every 25 ms.
The existing deadline remains two seconds; the heartbeat is 60 seconds. Neither
graph warming nor a vault-content change event is allowed. The fixed test also
requires an actual native change callback, so recovery hints alone cannot pass.
No provider/model calls or real vaults are involved.

| Linux run, Bun 1.3.9 | Passed | Failed |
| --- | ---: | ---: |
| [Baseline `9a6eee5`](https://github.com/elsehow/BigBrain/actions/runs/35544537975) | 91 | 9 |
| [Fixed `8be7075`](https://github.com/elsehow/BigBrain/actions/runs/35544803064) | 100 | 0 |
| [Fixed with recovery diagnostics `2f45458`](https://github.com/elsehow/BigBrain/actions/runs/35544877259) | 100 | 0 |

All nine baseline failures recorded `ENOENT` for a `.tmp-*` file beneath
`.state/assertion.lock/`, zero delivered paths, and valid current status.
The second fixed run captured two actual `ENOENT` recoveries: each opened a
replacement watcher and then received native changes, with progress delivered
in **204.6 ms** and **494.8 ms**. Every fixed trial finished within the unchanged
two-second deadline; the slowest was 956.0 ms. These are observations from the
listed runs, not a universal failure-rate or latency guarantee.

[Raw samples and failure/recovery diagnostics](2026-09-20-native-watcher-recovery.json)
retain all 300 Linux trials. A separate 100-trial Darwin arm64 run also passed.

## Fix and boundaries

`createLive` owns watcher recovery alongside its existing lifecycle:

- Close and reopen a watcher after `ENOENT`, with retry delays from 100 ms up
  to one second. Successful notifications reset the delay. Ordinary operation
  has no retry timer.
- Treat an in-vault error path as a freshness hint, since the triggering write
  may already be complete when the replacement watcher becomes ready. Progress
  paths still update only gardener SSE; content paths retain normal refresh
  behavior. Paths outside the vault are ignored.
- Reject callbacks from an obsolete watcher and cancel pending retries on stop.
  Errors during subscription, including repeated failures, follow the same path.
- Continue logging other watcher errors while keeping the viewer and heartbeat
  alive.

Deterministic tests cover retrying, failures during subscription, stale callbacks,
shutdown, content-path hints, and progress appearing/disappearing during recovery.
The native test keeps failure diagnostics and reports successful error recovery.
CI retains the 100-repetition native regression.

The full local suite passed **1,991 tests**, with **3 opt-in tests skipped**.
Both fixed Linux runs also passed the full suite: **1,988 passed, 6 skipped**
(including three platform-specific packaging tests). Root typecheck, lint,
generated-plugin checks, Svelte checking, and production UI build passed.
