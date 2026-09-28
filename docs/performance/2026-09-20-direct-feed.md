# Direct feed preparation (#804)

A direct `/api/recent` request now prepares a missing/outdated feed in the
same disposable worker machinery used by graph preparation. Warm requests
read only their indexed page. Workers use the existing revision-checked
publisher and shared freshness clock; simultaneous feed requests share one
preparation regardless of page/filter. There is no persistent idle worker.

Synthetic scratch vault, macOS arm64, Bun 1.3.9: 1,200 sources with about
38 MB of body text. The HTTP harness dispatches the real viewer route,
without starting graph warming. A concurrent `/ping` and a 5 ms timer probe
measure server responsiveness. No model calls or real vault reads/writes.
Before: 8ee36a4 plus route tests. After: this change. Single-run timings,
not an SLA; raw samples are in the adjacent JSON.

| Case | Feed before → after | Concurrent ping before → after | Maximum timer gap before → after |
|---|---:|---:|---:|
| First ever, no projection | 1,028 → 1,029 ms | 1,028 → 7.5 ms | 1,021 → 6.3 ms |
| New arrival | 48 → 81 ms | 49 → 1.2 ms | 48 → 5.9 ms |
| Unchanged periodic census | 5.9 → 36 ms | 6.1 → 1.3 ms | 5.9 → 6.2 ms |
| Warm median, five reads | 1.3 → 1.2 ms | 1.4 → 1.3 ms | about 6 ms in both |

This removes shared-thread stalls, not initial indexing work. Worker startup
adds about 30 ms to a revision/census miss; cached reads stay immediate.
Before/after response hashes match for every case, including pagination
metadata and the changed arrival. Tests also cover filtered pages, filing
verdicts, notifications during preparation, missed notifications, stale
publication rejection, and failure/retry. Existing graph background tests
exercise the extracted worker lifecycle.

Reproduce from a checkout, passing an engine checkout to compare:

```sh
bun test/support/profileDirectFeed.ts /path/to/engine /tmp/feed.json
```

The endpoint's existing parameter policy is unchanged. Connector-filter
behavior is exercised at the shared reader, where that parameter exists.
