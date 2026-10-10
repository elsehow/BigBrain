/**
 * liveEvents.ts — the viewer's live stream, extracted from web/server.ts
 * (#291, the SSE half of #260's seam list): one watcher over the vault,
 * fanned out to SSE clients. Open tabs hold /api/events; any change under
 * the watched trees (a pull landing, triage filing, deep work curating, a
 * vault.yaml edit) becomes one debounced ping, and each tab re-fetches
 * what it's showing.
 *
 * The old server started all of this as live side effects inside
 * startLive(); here it is a value with a lifecycle — createLive() only
 * declares, start() opens the watcher and the heartbeat, stop() closes
 * both and drains the pending debounce — so bun test can drive the fan-out
 * (fake client in, change event in, ping out) with no filesystem watcher
 * and no interval left holding the event loop open. The watch itself is a
 * seam (LiveWatchFn, an injected function) for deterministic fan-out and
 * recovery tests; the native regression also exercises the real watcher.
 */

import { GARDENER_PROGRESS_DIR, readGardenerProgress } from "./gardenerProgress";
import { watch as fsWatch } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { BROWSE_ROOTS } from "./browsePaths";
import { isLedgerPath } from "./retrieval";
import { invalidateGraphCaches, warmGraphLayoutAsync } from "./graphCache";
import { claimProjectionRecovery, syncAssertionProjection } from "./assertionProjection";
import { background } from "./readModelBackground";
import { readModelRevision } from "./vaultReadModel";

// The watched trees. `queue` earns its place: a message's whole lifecycle
// (enqueued → claimed → done) happens under it, and without the watch a
// fresh arrival sat invisible until some OTHER tree happened to change.
export const WATCHED: ReadonlySet<string> = new Set([
  ...BROWSE_ROOTS,
  "journal",
  "queue",
  "vault.yaml",
  "prompts",
  "observations",
  "log",
]);

/** What the fan-out needs from a client — ServerResponse satisfies it, and
 * so does a test's array-backed fake. */
export interface LiveClient {
  write(chunk: string): unknown;
}

/** Watch a vault root recursively; `onChange` gets the changed path
 * relative to the root, `onError` the raw watcher error (the ENOENT/other
 * split is policy and stays in createLive, not here). Returns a closer. */
export type LiveWatchFn = (
  root: string,
  onChange: (rel: string) => void,
  onError: (err: NodeJS.ErrnoException) => void
) => { close: () => void };

// On Linux this needs Bun >= 1.3.14 (CI pins it). Every recursive fs.watch in
// a Bun process shares one inotify thread and one directory-scan pool, and
// older Bun wedged both, silently and for the life of the process (#124):
// before 1.3.11 one read() of 128+ queued inotify events (a pull, an rm -rf)
// left the thread replaying that buffer forever (oven-sh/bun#27667); before
// 1.3.13 closing a watcher while its scan was still running deadlocked a pool
// thread (oven-sh/bun#29391), and handleWatchError closes mid-scan by
// definition. Once every pool thread was stuck, new watchers watched only
// their root. Nothing reaches onError in either case, and reopening cannot
// help: the stuck state belongs to the runtime, not to this watcher. 1.3.13
// still hung a stress run outright; 1.3.14 rewrote fs.watch (oven-sh/bun#29952).
export const defaultLiveWatch: LiveWatchFn = (root, onChange, onError) => {
  const w = fsWatch(root, { recursive: true }, (_event, filename) =>
    onChange(filename?.toString() ?? "")
  );
  w.on("error", (err) => onError(err as NodeJS.ErrnoException));
  return {
    close: () => {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    },
  };
};

export interface LiveOptions {
  applicationChanges?: import("./applicationChanges").ApplicationChanges;
  root: string;
  /** First path segments that count as vault changes; WATCHED by default. */
  watched?: ReadonlySet<string>;
  watch?: LiveWatchFn;
  /** The search-cache warm ridden off the same change signal; the assertion
   * projection's incremental sync by default (#495 — the legacy markdown
   * index is gone from the product path). */
  refresh?: (root: string) => void;
  /** The graph-layout settle ridden off the same signal; graphCache's
   * warmGraphLayoutAsync by default. A seam for the same reason `refresh` is one:
   * a fan-out test must not run a force simulation. */
  warmLayout?: (root: string) => void | Promise<void>;
  /** The log census that heals what the write path could not, run at start
   * and after a change under `log/`; recoverInBackground by default. A seam
   * like `refresh`: a fan-out test must not spawn a worker. Resolves whether
   * it changed the projection. */
  recover?: (root: string) => Promise<boolean>;
  /** A pull touches many files at once — one ping covers them. */
  debounceMs?: number;
  /** Comment-only heartbeat so idle connections aren't reaped by timeouts. */
  heartbeatMs?: number;
  log?: (msg: string) => void;
}

export interface Live {
  /** Open the watcher, start the heartbeat, warm the search index. */
  start(): void;
  /** Close the watcher, stop the heartbeat, drop any pending ping. */
  stop(): void;
  addClient(c: LiveClient): void;
  removeClient(c: LiveClient): void;
  /** The watcher callback — public so tests feed change events directly. */
  handleChange(rel: string): void;
}

export function createLive(opts: LiveOptions): Live {
  const {
    root,
    watched = WATCHED,
    watch = defaultLiveWatch,
    refresh = syncAssertionProjection,
    warmLayout = warmGraphLayoutAsync,
    recover = recoverInBackground,
    debounceMs = 300,
    heartbeatMs = 30_000,
    log = (msg) => console.error(msg),
  } = opts;

  const clients = new Set<LiveClient>();
  let unsubscribe: (() => void) | undefined;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watcher: { close: () => void } | null = null;
  let watchRetry: ReturnType<typeof setTimeout> | null = null;
  let watchRetryMs = 100;
  let watchGeneration = 0;

  let revision = 0;
  let logsTouched = false;
  let stopped = false;
  let usageTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let lastProgress = "null";
  function publishProgress(): void {
    const data = JSON.stringify(readGardenerProgress(root));
    if (stopped || data === lastProgress) return;
    lastProgress = data;
    for (const c of clients) c.write(`event: gardener\ndata: ${data}\n\n`);
  }

  function handleChange(rel: string): void {
    // Local status is not vault content: never invalidate a graph or replay
    // the projection for a tool-start/tool-end update.
    if (rel === GARDENER_PROGRESS_DIR || rel.startsWith(GARDENER_PROGRESS_DIR + sep)) {
      if (!stopped && !progressTimer) progressTimer = setTimeout(() => { progressTimer = null; publishProgress(); }, 100);
      return;
    }
    // A provider ran out of usage credits, or has them again: the base's banner re-reads.
    if (rel === `.state${sep}credits.json`) {
      if (!stopped) for (const c of clients) c.write('event: credits\ndata: {"changed":true}\n\n');
      return;
    }
    // Model accounting changes usage, never the vault's content or topology.
    if (rel === `journal${sep}model-runs` || rel.startsWith(`journal${sep}model-runs${sep}`)) {
      if (!stopped && !usageTimer) usageTimer = setTimeout(() => {
        usageTimer = null;
        for (const c of clients) c.write('event: usage\ndata: {"changed":true}\n\n');
      }, debounceMs);
      return;
    }
    const first = rel.split(sep)[0];
    if (!first || !watched.has(first)) return; // .git / .state churn etc.
    // journal/retrieval/ is under a watched tree but is the viewer's own
    // exhaust: /api/note appends a `use` record on every read. Pinging on it
    // hands every open note view its own echo — read → ping → refetch →
    // read — a loop that flashes the tab at the debounce rate and rebuilds
    // the search index twice a second for as long as the tab stays open
    // (#247/#248).
    if (isLedgerPath(rel) || stopped) return;
    if (first === "log") logsTouched = true;
    announce();
  }

  /** A vault change: drop the graph now, ping once it has settled again. */
  function announce(): void {
    revision++;
    invalidateGraphCaches(root);
    if (pingTimer) return; // debounce: a pull touches many files at once
    pingTimer = setTimeout(async () => {
      pingTimer = null;
      const current = revision;
      // Engine writes have projected themselves already; a log file that
      // did not (written by hand, or by a process that died mid-landing)
      // heals here, in a worker, before the graph is rebuilt.
      if (logsTouched) {
        logsTouched = false;
        try {
          await recover(root);
        } catch {
          /* the next process to start recovers */
        }
      }
      // Reconcile edited Markdown off the same signal, so the first search
      // after an edit is instant instead of paying the catch-up.
      try {
        refresh(root);
      } catch {
        /* index is best-effort; search rebuilds lazily anyway */
      }
      // Rebuild and settle off-thread before pinging. Requests for the same
      // revision share this work, while HTTP and heartbeat traffic keep moving.
      try {
        await warmLayout(root);
      } catch {
        /* layout is best-effort; graphWithLayout computes on demand */
      }
      if (stopped || current !== revision) return;
      for (const c of clients) c.write(`data: {"changed":true}\n\n`);
    }, debounceMs);
  }

  function openWatcher(): void {
    const generation = ++watchGeneration;
    try {
      const opened = watch(root, rel => {
        if (stopped || generation !== watchGeneration) return;
        watchRetryMs = 100;
        handleChange(rel);
      }, err => {
        if (!stopped && generation === watchGeneration) handleWatchError(err);
      });
      // An injected/native watcher may report an error while being opened.
      if (stopped || generation !== watchGeneration) opened.close();
      else watcher = opened;
    } catch (err) {
      if (!stopped && generation === watchGeneration) handleWatchError(err as NodeJS.ErrnoException);
    }
  }

  // Bun's Linux recursive scan can encounter an atomic-write temporary file
  // after it has been renamed. ENOENT can leave that watcher delivering no
  // events (#865), so swallowing the error is not enough. Reopen with bounded
  // backoff; ordinary operation has no retry timer. Old callbacks are ignored.
  function handleWatchError(err: NodeJS.ErrnoException): void {
    if (err.code === "ENOENT") {
      // The failed path is also a freshness hint: the triggering update may
      // already be complete by the time its replacement watcher is ready.
      const path = (err as NodeJS.ErrnoException & { path?: string }).path;
      if (path) {
        const rel = relative(root, path);
        if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) handleChange(rel);
      }
      watchGeneration++;
      watcher?.close();
      watcher = null;
      if (!watchRetry) {
        watchRetry = setTimeout(() => { watchRetry = null; openWatcher(); }, watchRetryMs);
        watchRetryMs = Math.min(watchRetryMs * 2, 1000);
      }
      return;
    }
    // Other failures remain visible; the viewer and heartbeat keep running.
    log(`BigBrain web: vault watcher error (live updates may stop): ${err}`);
  }

  return {
    start(): void {
      stopped = false;
      unsubscribe?.();
      unsubscribe = opts.applicationChanges?.subscribe(event => {
        for (const c of clients) c.write(`event: application\ndata: ${JSON.stringify(event)}\n\n`);
      });
      watchRetryMs = 100;
      openWatcher();
      heartbeat = setInterval(() => {
        publishProgress(); // also clears a dead lock holder after a crash
        for (const c of clients) c.write(": ping\n\n");
      }, heartbeatMs);
      // Recover once at boot, in a worker: the viewer serves the projection
      // as it stands meanwhile, since every engine write projected itself.
      // A heal that changed it pings like any other change.
      void recover(root).then((changed) => { if (changed && !stopped) announce(); }, () => {});
    },
    stop(): void {
      stopped = true;
      unsubscribe?.(); unsubscribe = undefined;
      revision++;
      if (usageTimer) clearTimeout(usageTimer);
      usageTimer = null;
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = null;
      watchGeneration++;
      if (watchRetry) clearTimeout(watchRetry);
      watchRetry = null;
      watcher?.close();
      watcher = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (pingTimer) clearTimeout(pingTimer);
      pingTimer = null;
    },
    addClient(c: LiveClient): void {
      clients.add(c);
      if (opts.applicationChanges) c.write(`event: application\ndata: ${JSON.stringify(opts.applicationChanges.snapshot())}\n\n`);
      const progress = readGardenerProgress(root);
      if (progress) c.write(`event: gardener\ndata: ${JSON.stringify(progress)}\n\n`);
    },
    removeClient(c: LiveClient): void {
      clients.delete(c);
    },
    handleChange,
  };
}

/** The log census off the request path: recoverAssertionProjection in a
 * worker, while this process counts its recovery as done so a read meanwhile
 * does not repeat it synchronously. Resolves whether the projection moved. */
export async function recoverInBackground(root: string): Promise<boolean> {
  const before = readModelRevision(root);
  const withdraw = claimProjectionRecovery(root);
  try {
    await background({ kind: "recover", root });
  } catch (error) {
    withdraw();
    throw error;
  }
  return readModelRevision(root) !== before;
}
