/**
 * liveEvents.ts — the viewer's live stream, extracted from web/server.ts
 * (#291, the SSE half of #260's seam list), fanned out to SSE clients. Open
 * tabs hold /api/events, and two signals feed it. A commit to the projection
 * — every engine write, from any process — is heard through `PRAGMA
 * data_version` (lib/projectionWake.ts), asked whenever the WAL changes and
 * every few seconds besides. A change to the files people edit outside the
 * engine (notes, vault.yaml) or engine state outside the projection (the
 * queue, journals) comes from one watcher over the vault. Either becomes one
 * debounced `event: views` carrying each view's stamp (lib/viewStamps.ts), and
 * each tab fetches only the views whose stamp moved. A connection opens with
 * the current stamps.
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
import { maintainGraphView, onGraphView } from "./maintainedGraph";
import { viewStamps, type ViewStamps } from "./viewStamps";
import { assertionDbPath, claimProjectionRecovery, projectNotes } from "./assertionProjection";
import { projectionWake, type ProjectionWake } from "./projectionWake";
import { background } from "./readModelBackground";
import { readModelRevision } from "./vaultReadModel";

// The watched trees. `queue` earns its place: a message's whole lifecycle
// (enqueued → claimed → done) happens under it, and without the watch a
// fresh arrival sat invisible until some OTHER tree happened to change.
// `log/` is not one: every engine write to it commits to the projection,
// which the wake hears, and a file put there by hand is recovered by the next
// process to start, or by `bigbrain recover`.
export const WATCHED: ReadonlySet<string> = new Set([
  ...BROWSE_ROOTS,
  "journal",
  "queue",
  "vault.yaml",
  "prompts",
  "observations",
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
  /** The notes door: project the notes a change named (every note, when the
   * watcher may have missed some); assertionProjection.projectNotes by default. */
  refresh?: (root: string, paths?: string[]) => void;
  /** The graph view's upkeep ridden off the same signal: maintainedGraph's
   * maintainGraphView by default, which builds only when the projection's
   * revision moved. A seam for the same reason `refresh` is one: a fan-out
   * test must not run a force simulation. */
  warmLayout?: (root: string) => void | Promise<void>;
  /** The log census that heals what the write path could not, run once at
   * start; recoverInBackground by default. A seam like `refresh`: a fan-out
   * test must not spawn a worker. What it heals commits, so the wake hears it. */
  recover?: (root: string) => Promise<unknown>;
  /** How commits to the projection are heard; projectionWake by default. */
  wake?: (root: string) => ProjectionWake;
  /** The check that covers a missed WAL wake-up. */
  backstopMs?: number;
  /** Each view's stamp, given the stamp of the watched files outside the
   * projection; viewStamps by default. */
  stamps?: (root: string, files: string) => ViewStamps;
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
  /** Push the stamps to any client they moved for, after a change the
   * watcher cannot see (joining a shared vault). */
  refreshViews(): void;
}

export function createLive(opts: LiveOptions): Live {
  const {
    root,
    watched = WATCHED,
    watch = defaultLiveWatch,
    refresh = projectNotes,
    warmLayout = maintainGraphView,
    recover = recoverInBackground,
    wake = projectionWake,
    backstopMs = 5_000,
    stamps = viewStamps,
    debounceMs = 300,
    heartbeatMs = 30_000,
    log = (msg) => console.error(msg),
  } = opts;

  const clients = new Set<LiveClient>();
  let unsubscribe: (() => void) | undefined;
  let unlanded: (() => void) | undefined;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watcher: { close: () => void } | null = null;
  let watchRetry: ReturnType<typeof setTimeout> | null = null;
  let watchRetryMs = 100;
  let watchGeneration = 0;

  let revision = 0;
  /** Notes changed since the last settle, projected before it; every note
   * when the watcher was lost and may have missed some. */
  const notePaths = new Set<string>();
  let notesLost = false;
  let stopped = false;
  let commits: ProjectionWake | null = null;
  let backstop: ReturnType<typeof setInterval> | null = null;
  const walRel = relative(root, `${assertionDbPath(root)}-wal`);
  /** Whether another connection committed: then the views may have moved. */
  function checkCommits(): void {
    if (!stopped && commits?.moved()) announce();
  }
  let usageTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let lastProgress = "null";
  // Watched files outside the projection; the epoch names this process, so a
  // restart reads as a move.
  const epoch = crypto.randomUUID().slice(0, 8);
  let files = 0;
  /** The stamps each client was last sent: it hears only a move from those. */
  const sent = new WeakMap<LiveClient, string>();
  function sendViews(c: LiveClient, data: string): void {
    if (sent.get(c) === data) return;
    sent.set(c, data);
    c.write(`event: views\ndata: ${data}\n\n`);
  }
  const viewsNow = () => JSON.stringify(stamps(root, `${epoch}:${files}`));
  function publishViews(): void {
    if (stopped || !clients.size) return;
    const data = viewsNow();
    for (const c of clients) sendViews(c, data);
  }
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
    // A commit: data_version says whether it was another connection's.
    if (rel === walRel) { checkCommits(); return; }
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
    if (BROWSE_ROOTS.has(first)) notePaths.add(rel);
    else files++;
    announce();
  }

  /** A vault change: push the stamps once it has settled. */
  function announce(): void {
    revision++;
    if (pingTimer) return; // debounce: a pull touches many files at once
    pingTimer = setTimeout(async () => {
      pingTimer = null;
      const current = revision;
      // Project edited notes: reads never look at the files. The commit is
      // heard like any other.
      if (notesLost || notePaths.size) {
        const paths = notesLost ? undefined : [...notePaths];
        notesLost = false;
        notePaths.clear();
        try {
          refresh(root, paths);
        } catch {
          /* the next edit, or the next process to start, projects them */
        }
      }
      // Rebuild and settle off-thread before pinging. Requests for the same
      // revision share this work, while HTTP and heartbeat traffic keep moving.
      try {
        await warmLayout(root);
      } catch {
        /* layout is best-effort; graphWithLayout computes on demand */
      }
      if (stopped || current !== revision) return;
      publishViews();
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
        if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
          notesLost = true; // what it missed meanwhile, no event will name
          handleChange(rel);
        }
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
      // A graph view that lands outside a change (the first start's build, a
      // request's) is pushed too.
      unlanded?.();
      unlanded = onGraphView(landed => { if (landed === root) publishViews(); });
      watchRetryMs = 100;
      openWatcher();
      commits?.close();
      commits = wake(root);
      commits.moved(); // the baseline
      // Also the bound on notes a lost watcher missed: projected within it.
      backstop = setInterval(() => { if (notesLost) announce(); else checkCommits(); }, backstopMs);
      backstop.unref?.();
      heartbeat = setInterval(() => {
        publishProgress(); // also clears a dead lock holder after a crash
        for (const c of clients) c.write(": ping\n\n");
      }, heartbeatMs);
      // Recover once at boot, in a worker: the viewer serves the projection
      // as it stands meanwhile, since every engine write projected itself.
      // A heal commits, and is pushed like any other commit.
      void recover(root).catch(() => {});
    },
    stop(): void {
      stopped = true;
      unsubscribe?.(); unsubscribe = undefined;
      unlanded?.(); unlanded = undefined;
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
      if (backstop) clearInterval(backstop);
      backstop = null;
      commits?.close();
      commits = null;
      if (pingTimer) clearTimeout(pingTimer);
      pingTimer = null;
    },
    addClient(c: LiveClient): void {
      clients.add(c);
      if (opts.applicationChanges) c.write(`event: application\ndata: ${JSON.stringify(opts.applicationChanges.snapshot())}\n\n`);
      const progress = readGardenerProgress(root);
      if (progress) c.write(`event: gardener\ndata: ${JSON.stringify(progress)}\n\n`);
      sendViews(c, viewsNow());
    },
    removeClient(c: LiveClient): void {
      clients.delete(c);
    },
    handleChange,
    refreshViews: publishViews,
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
