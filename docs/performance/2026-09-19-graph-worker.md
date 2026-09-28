# Graph display layout worker

The compact overview now runs in a disposable module Web Worker. The canvas initially uses the server's settled positions, then rebuilds with the compact positions when they arrive. The solver and its geometry are unchanged. The existing layout cache still covers all solver inputs and survives same-tab reloads.

Only geometry is sent to the worker. A changed input terminates the obsolete job; stale replies are ignored. Completion, failure, and component teardown terminate the worker. If workers fail, the graph keeps server positions rather than synchronously calculating on the UI thread. Failed inputs do not trigger retry loops.

## Validation

The production bundle was exercised in Chrome against an intercepted, entirely synthetic graph with 4,166 nodes and 12,008 edges:

| Measurement | Fresh tab | Cached reload |
| --- | ---: | ---: |
| First graph draw | 177.5 ms | 114.9 ms |
| Worker result available | 2,910.7 ms | No worker needed |
| Longest main-thread task | 92 ms | 75 ms |

No browser errors. This is a same-scale synthetic check, not an apples-to-apples rerun of the private snapshot. The prior private-vault profile recorded a 3,514 ms main-thread layout task; this check establishes that the expensive calculation now continues after the first draw without monopolizing the UI thread. Total layout CPU cost remains; backend graph construction is unchanged. Applying the finished layout can visibly reposition the graph once.

Reproduce after `bun run --cwd web/ui build` with `node test/support/graphWorker.browser.cjs` (set `PLAYWRIGHT_MODULE` if needed). The harness serves the built assets by request interception and mocks all APIs; it reads no vault and contacts no external hosts.

Cache, display-layout, and worker lifecycle tests: 17 pass. Root TypeScript, Svelte checks, production build, and targeted lint passed.
