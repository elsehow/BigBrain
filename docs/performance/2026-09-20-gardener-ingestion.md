# Gardener ingestion — 2026-09-20

Issue #840. A real-provider replay benchmark on a disposable copy of the owner's
vault, using the production gardener prompt, runTend, ClaudeSession, and shared MCP
handlers. No production behavior was changed for the benchmark.

## Workload and isolation

The copied assertion projection contains 3,448 source insertions, 4,905 live
assertions, 715 entities and 6,235 source links before the run. Six recent eligible
intake items were selected across meeting, reading, mail, agent-chat and other
classes (517–20,539 body characters), together with the two staged arrivals present
at snapshot time. The copy excludes credentials, integrations, the original git
repository, and private runtime sessions. It gets a new local git repository.

For replay, 25 prior assertion events citing the selected insertions were removed
**only from the scratch copy**, then its projection was rebuilt. No unrelated
pending items needed suppression. Other context remains current, so later knowledge
may influence replay decisions. This measures a bounded workload, not an unbiased
sample of new production arrivals or an assessment of assertion quality.

The configured `opus` alias resolved to `claude-opus-5` (read from the scratch
session's SDK transcript metadata). Authentication is the owner's Claude Max
subscription. The model/provider was not changed for the benchmark. One normal
gardener round drains work; the separate memory pass is explicitly excluded.

An initial attempt failed authentication before any tool call. The owner reconnected
Claude and the measured run used a fresh copy of the unchanged replay fixture.
The failed startup and its viewer observations are excluded from successful-run
results. Raw content, paths, source IDs and SDK transcripts are not published.

## Results

Eight initial arrivals completed in **136.23 seconds (3.52/minute)**: six replayed
intake items, one staged admission and one staged pass. Both queues ended empty.
The gardener appended 14 assertions, with zero rejected items, identical retries,
or deduplicated submissions. The one admission reached its first assertion after
49.67 seconds. This is one workload/run, not a general throughput guarantee.

Shared handlers occupied **3.45 seconds (2.53%)** of wall time; the remaining
132.78 seconds were outside handlers. Improving local handlers alone therefore
has limited scope to shorten this run. This does not establish that another
provider would be faster or produce equally useful assertions.

| Shared tool | Calls | Total ms | Median ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| next | 3 | 908.94 | 266.16 | 622.89 |
| search_vault | 6 | 386.72 | 31.43 | 106.76 |
| open | 1 | 1.12 | 1.12 | 1.12 |
| read_note | 1 | 1.05 | 1.05 | 1.05 |
| submit | 3 | 2152.81 | 454.27 | 1474.81 |

All handlers completed without exceptions. Across 15 model turns, reported usage
was 24 uncached input tokens, 10,886 output tokens, 503,217 cache-read tokens and
64,592 cache-write tokens. Cache reads include repeated context across turns;
they are not unique input. No dollar cost was reported for the subscription run.

The native process-tree sampler collected 133 samples: mean CPU 4.39% of one
core, peak summed physical footprint 493.78 MiB, at most three observed processes,
and six samples with process churn. The gardener host itself used 4.72 CPU seconds
and peaked at 445.63 MiB RSS. Its 100 ms timer delay was median 1.02 ms, p95 1.71 ms,
and maximum 1394.17 ms. These are different memory measures; do not add them.

### Concurrent viewer search

| Measurement | Baseline (8 searches) | During ingestion (54 searches) |
| --- | ---: | ---: |
| Response median | 207.97 ms | 142.28 ms |
| Response p95 | 684.73 ms | 1910.31 ms |
| Response max | 684.73 ms | 2607.11 ms |
| Painted median | 237.78 ms | 174.17 ms |
| Painted p95 | 725.98 ms | 1936.88 ms |
| Painted max | 725.98 ms | 2636.27 ms |

All measured search responses were HTTP 200, with no browser page errors. The
lower during-run median is not evidence that ingestion improves search: the
baseline is small and warming differs. Occasional multi-second stalls mean we
cannot call responsiveness uniformly healthy.

A direct HTTP control after ingestion reproduced the issue without a model:
the first request took 2251.93 ms; the remaining 23 took 45–97 ms. Search decorates
all ranked hits before pagination; source-thread decoration can synchronously
load the full assertion and insertion logs. Isolating that record load on the
same snapshot measured 1449.28 / 423.46 / 348.06 ms across three forced cold loads,
versus less than 0.02 ms warm. Ranking took 178.64 / 49.79 / 39.98 ms respectively.
This identifies a substantial cold-path cost, not a complete attribution of each
browser spike. The profiling server uses the record's 60-second fallback TTL;
the desktop's live watchers invalidate on changes instead.

Follow-up [#841](https://github.com/elsehow/BigBrain/issues/841) covers cold and
invalidated search decoration with production watchers. Follow-up
[#842](https://github.com/elsehow/BigBrain/issues/842) covers the same-cohort OpenAI
comparison, quality review and provider preferences in `lib/model-defaults.yaml`.
Explicit user choices must continue to win over recommended defaults.

## Instrumentation and limits

- Test-only wrappers time the existing MCP handlers. They do not replace handlers,
  validators, schemas, role restrictions, or model execution. The timed intervals
  exclude the profiler's byte-count serialization. Overlapping intervals are merged
  before calculating the fraction of wall time spent in handlers.
- Time outside handlers includes provider startup, network, model work, transport,
  serialization, and runner bookkeeping. It is **not** isolated model thinking time.
- Submission statistics count result rows and exact repeated item payloads. A revised
  rejected assertion is not an identical retry; rejections and repeats are distinct.
  Admission-to-first-assertion measures newly admitted source IDs, not passed items.
- Throughput counts the eight initial arrivals once each. An admitted staged item
  is not counted a second time when its insertion is filed. Completion additionally
  requires both intake and staging queues to be empty.
- Host CPU/RSS and 100 ms timer delay come from the gardener process. The macOS
  sampler also follows its process descendants using calibrated native counters;
  it excludes its own process and does not collect arguments or executable names.
  Its one-second samples can miss short-lived children and startup CPU; process
  churn is reported. Summed physical footprints can include shared pages.
- Viewer probing uses a separate process serving a read-only subset of the real
  web routes and the production UI bundle. It repeatedly searches eight fixed
  common terms, waiting at least two seconds between interactions so a repeated
  term ages out of the 15-second client search cache. Timings include automation,
  debounce, response processing and two animation frames after the result list.
  Supervisor activity, live SSE invalidations, Quick generation, and integrations
  are absent. This tests concurrent search interaction, not all UI responsiveness.
- The initial page load/layout is warmed before baseline measurement. The small
  baseline sample's p95 is its maximum, not a reliable population percentile.
  No hardware GPU or long-session leak claim follows from this run.

## Reproduction

In an isolated engine worktree, install dependencies and build the UI. Create the
private fixture (its path is printed; preparation does not call a model):

```
bun test/support/profileGardener.ts prepare <real-vault>
```

Start the read-only viewer, then its browser probe (Playwright plus Chrome required):

```
bun test/support/vaultScaleServer.ts <snapshot> 53927
PLAYWRIGHT_MODULE=/path/to/playwright node test/support/gardenerViewer.browser.cjs <snapshot>
```

After `viewer-ready`, start the live subscription run:

```
bun test/support/profileGardener.ts run <snapshot> --live
```

The harness refuses unmarked paths, symlinks, source-root reuse, changed queues,
external database overrides, and previously started snapshots. The current live
baseline supports Claude subscription authentication. Safety tests cover its main
refusal paths. Each comparison needs a fresh preparation or an unprocessed clone
with matching private fixture metadata. Use the same frozen cohort for model
comparisons; prepare's recent-item selection can change as the real vault grows.

The local `.profile-result.json`, `.profile-viewer.json` and
`.profile-resources.json` contain aggregate results. Private fixture metadata and
journals stay in the scratch directory. Shut down the viewer server afterward.
