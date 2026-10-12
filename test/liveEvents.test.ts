import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createLive, recoverInBackground, type LiveClient, type LiveWatchFn, WATCHED } from "../lib/liveEvents";
import { assertionDbPath, assertionProjectionStats, projectSourceInsertion, syncAssertionProjection } from "../lib/assertionProjection";
import { projectionWake } from "../lib/projectionWake";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { insertion, mdVault } from "./support/vault";

/** Sync as a read does, then count what the projection holds. */
const synced = (root: string) => { syncAssertionProjection(root); return assertionProjectionStats(root); };

// The SSE fan-out, driven end to end with no filesystem watcher (#291): a
// fake client registers, a change event goes in, the debounced `event: views`
// comes out — and the retrieval-ledger guard stays silent, which is the pin on
// #247/#248 (the ledger is the read path's own exhaust; echoing it gave
// every open note view a read → ping → refetch → read loop).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeClient(): LiveClient & { writes: string[] } {
  const writes: string[] = [];
  return { writes, write: (chunk: string) => writes.push(chunk) };
}

/** A live instance wired for tests: injected watch (never fs.watch), tight
 * timers, a counting refresh, a captured log, and stamps that move on every
 * settle. The client's connection stamps are dropped: each test hears only
 * what its changes push. */
function harness(opts: { watchThrows?: boolean } = {}) {
  const client = fakeClient();
  const logged: string[] = [];
  let refreshes = 0;
  let recoveries = 0;
  let warms = 0;
  let warmThrows = false;
  let closed = 0;
  let opened = 0;
  let stamped = 0;
  const failures: Array<(err: NodeJS.ErrnoException) => void> = [];
  let onError: ((err: NodeJS.ErrnoException) => void) | undefined;
  const watch: LiveWatchFn = (_root, _onChange, onErr) => {
    opened++;
    if (opts.watchThrows) throw new Error("watch unavailable");
    onError = onErr;
    failures.push(onErr);
    return { close: () => closed++ };
  };
  const live = createLive({
    root: "/nonexistent-vault",
    watch,
    refresh: () => refreshes++,
    recover: async () => { recoveries++; return false; },
    warmLayout: () => {
      warms++;
      if (warmThrows) throw new Error("layout unavailable");
    },
    stamps: () => ({ generation: "g", revision: String(++stamped), views: { graph: "", joined: "", feed: "", files: "" } }),
    debounceMs: 5,
    heartbeatMs: 10,
    log: (msg) => logged.push(msg),
  });
  live.addClient(client);
  client.writes.length = 0;
  return {
    live,
    client,
    logged,
    refreshes: () => refreshes,
    recoveries: () => recoveries,
    warms: () => warms,
    breakWarm: () => { warmThrows = true; },
    closed: () => closed,
    opened: () => opened,
    fireError: (err: NodeJS.ErrnoException) => onError?.(err),
    oldError: (err: NodeJS.ErrnoException) => failures[0]?.(err),
  };
}

const PING = expect.stringMatching(/^event: views\ndata: \{"generation":"g",.*\}\n\n$/);
const pinged = (writes: string[]) => writes.some((w) => w.startsWith("event: views\n"));

describe("createLive — the debounced change fan-out", () => {
  test("a change under a watched tree becomes one ping, after the debounce", async () => {
    const h = harness();
    h.live.handleChange("entities/ada-lovelace.md");
    expect(h.client.writes).toEqual([]); // not synchronous — the debounce holds it
    await sleep(20);
    expect(h.client.writes).toEqual([PING]);
    h.live.stop();
  });

  test("a burst of changes coalesces into one ping (a pull touches many files)", async () => {
    const h = harness();
    for (const rel of ["inbox/a.md", "references/b.md", "vault.yaml", "queue/inbox/c.json"])
      h.live.handleChange(rel);
    await sleep(20);
    expect(h.client.writes).toEqual([PING]);
    h.live.stop();
  });

  test("the ping rides the index rebuild: refresh fires with it, not per event", async () => {
    const h = harness();
    h.live.handleChange("inbox/a.md");
    h.live.handleChange("inbox/b.md");
    expect(h.refreshes()).toBe(0);
    await sleep(20);
    expect(h.refreshes()).toBe(1);
    h.live.stop();
  });

  test("the graph layout settles on the same signal, once per ping", async () => {
    // Settling here puts the simulation in the gap after a change instead of
    // inside the request the ping is about to provoke.
    const h = harness();
    h.live.handleChange("inbox/a.md");
    h.live.handleChange("inbox/b.md");
    expect(h.warms()).toBe(0);
    await sleep(20);
    expect(h.warms()).toBe(1);
    h.live.stop();
  });

  test("a layout that cannot settle still pings — the tab must not go dark", async () => {
    const h = harness();
    h.breakWarm();
    h.live.handleChange("inbox/a.md");
    await sleep(20);
    expect(pinged(h.client.writes)).toBe(true);
    h.live.stop();
  });

  test("the retrieval ledger is silence — the #247/#248 guard, pinned", async () => {
    const h = harness();
    // journal/ IS a watched tree (a run's decisions should ping), so the
    // first-segment check alone would let this through: the ledger guard is
    // the discriminator under test.
    expect(WATCHED.has("journal")).toBe(true);
    h.live.handleChange("journal/retrieval/2026-08.jsonl");
    await sleep(20);
    expect(h.client.writes).toEqual([]);
    expect(h.refreshes()).toBe(0);
    // and its sibling under journal/ still pings
    h.live.handleChange("journal/2026-08-13-editor.md");
    await sleep(20);
    expect(h.client.writes).toEqual([PING]);
    h.live.stop();
  });

  test("unwatched churn (.git, .state) never pings", async () => {
    const h = harness();
    h.live.handleChange(".git/objects/ab/cdef");
    h.live.handleChange(".state/search.db-wal");
    h.live.handleChange("");
    await sleep(20);
    expect(h.client.writes).toEqual([]);
    expect(h.refreshes()).toBe(0);
    h.live.stop();
  });

  test("a removed client stops hearing pings; the remaining one still does", async () => {
    const h = harness();
    const second = fakeClient();
    h.live.addClient(second);
    expect(second.writes).toEqual([PING]); // a connection opens with the stamps
    second.writes.length = 0;
    h.live.removeClient(h.client);
    h.live.handleChange("entities/x.md");
    await sleep(20);
    expect(h.client.writes).toEqual([]);
    expect(second.writes).toEqual([PING]);
    h.live.stop();
  });
});

describe("createLive — lifecycle", () => {
  test("start recovers once and opens the watcher; stop closes it and halts the heartbeat", async () => {
    const h = harness();
    h.live.start();
    expect(h.recoveries()).toBe(1); // the boot census, off the request path
    expect(h.refreshes()).toBe(0); // the server warms Markdown itself
    await sleep(25);
    expect(h.client.writes.filter((w) => w === ": ping\n\n").length).toBeGreaterThanOrEqual(1);
    h.live.stop();
    expect(h.closed()).toBe(1);
    const after = h.client.writes.length;
    await sleep(25);
    expect(h.client.writes.length).toBe(after); // heartbeat is dead — the loop drains
  });

  test("stop drops a pending debounced ping", async () => {
    const h = harness();
    h.live.handleChange("entities/x.md");
    h.live.stop();
    await sleep(20);
    expect(h.client.writes).toEqual([]);
  });

  test("an unavailable watcher degrades to no-push — start neither throws nor kills the heartbeat", async () => {
    const h = harness({ watchThrows: true });
    h.live.start();
    await sleep(25);
    expect(h.client.writes.filter((w) => w === ": ping\n\n").length).toBeGreaterThanOrEqual(1);
    h.live.stop();
  });

  test("a vanished file reopens the watcher; stale errors cannot close its replacement", async () => {
    const h = harness();
    h.live.start();
    h.fireError(Object.assign(new Error("gone"), { code: "ENOENT" }));
    expect(h.logged).toEqual([]);
    expect(h.closed()).toBe(1);
    await sleep(130);
    expect(h.opened()).toBe(2);
    h.oldError(Object.assign(new Error("late error"), { code: "ENOENT" }));
    expect(h.closed()).toBe(1);
    h.fireError(Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" }));
    expect(h.logged.length).toBe(1);
    expect(h.logged[0]).toContain("vault watcher error");
    // the stream survives the error: a change still pings
    h.live.handleChange("entities/x.md");
    await sleep(20);
    expect(pinged(h.client.writes)).toBe(true);
    h.live.stop();
  });

  test("stop cancels a pending watcher recovery and ignores late errors", async () => {
    const h = harness(); h.live.start();
    h.fireError(Object.assign(new Error("gone"), { code: "ENOENT" }));
    h.live.stop();
    h.oldError(Object.assign(new Error("late error"), { code: "ENOENT" }));
    await sleep(130);
    expect(h.opened()).toBe(1);
    expect(h.closed()).toBe(1);
  });

  test("recovery retries a failed subscription and closes a synchronously failed watcher", async () => {
    let attempts = 0, closed = 0;
    let ready!: () => void;
    const recovered = new Promise<void>(resolve => { ready = resolve; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const live = createLive({ root: "/nonexistent-vault", refresh: () => {}, heartbeatMs: 60_000,
      watch: (_root, _change, error) => {
        attempts++;
        if (attempts === 1) error(Object.assign(new Error("vanished during subscription"), { code: "ENOENT" }));
        if (attempts === 2) throw Object.assign(new Error("vanished again"), { code: "ENOENT" });
        if (attempts === 3) ready();
        return { close: () => { closed++; } };
      } });
    try {
      live.start();
      expect(closed).toBe(1);
      await Promise.race([recovered, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error("Watcher subscription did not recover")), 2000);
      })]);
      expect(attempts).toBe(3);
    } finally { if (timeout) clearTimeout(timeout); live.stop(); }
    expect(closed).toBe(2);
  });

  test("a vanished content path is reconciled; outside paths are ignored", async () => {
    const h = harness(); h.live.start();
    h.fireError(Object.assign(new Error("gone"), { code: "ENOENT", path: "/nonexistent-vault/memory/.tmp-file" }));
    await sleep(20);
    expect(pinged(h.client.writes)).toBe(true);
    // the notes are reconciled; recovery ran once, at boot
    expect(h.recoveries()).toBe(1); expect(h.refreshes()).toBe(1); expect(h.warms()).toBe(1);
    await sleep(110);
    h.fireError(Object.assign(new Error("outside"), { code: "ENOENT", path: "/elsewhere/memory/.tmp-file" }));
    await sleep(20);
    expect(h.recoveries()).toBe(1); expect(h.refreshes()).toBe(1); expect(h.warms()).toBe(1);
    h.live.stop();
  });

  test("the default watch is the real fs.watch — start() on a real directory opens and stop() closes", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-live-"));
    const live = createLive({ root, refresh: () => {}, heartbeatMs: 60_000 });
    live.start();
    live.stop(); // no leaked watcher/interval — bun test hangs if this fails
  });
});

describe("createLive — commits", () => {
  /** A live viewer over a real projection, with every view stamp real. */
  function viewer(backstopMs = 60_000) {
    const root = mdVault(), writes: string[] = [];
    appendSourceInsertionEvent(root, insertion({ id: `ins_${"a".repeat(24)}`, source_id: "a" }));
    synced(root);
    let recoveries = 0, refreshes = 0;
    const live = createLive({ root, watch: () => ({ close() {} }), refresh: () => { refreshes++; }, warmLayout: () => {},
      recover: async () => { recoveries++; }, debounceMs: 5, heartbeatMs: 60_000, backstopMs });
    live.addClient({ write: (text) => writes.push(text) });
    writes.length = 0; // the connection's stamps
    const wal = relative(root, `${assertionDbPath(root)}-wal`);
    return { root, live, writes, wal, recoveries: () => recoveries, refreshes: () => refreshes,
      done: () => { live.stop(); rmSync(root, { recursive: true, force: true }); } };
  }

  test("another connection's commit is heard through the WAL and pushed, with no Markdown walk", async () => {
    const v = viewer();
    try {
      v.live.start(); await sleep(10);
      expect(v.recoveries()).toBe(1); // boot
      const landed = insertion({ id: `ins_${"b".repeat(24)}`, source_id: "b" });
      appendSourceInsertionEvent(v.root, landed); projectSourceInsertion(v.root, landed);
      v.live.handleChange(v.wal); await sleep(30);
      expect(v.writes.filter((w) => w.startsWith("event: views\n"))).toHaveLength(1);
      expect(v.refreshes()).toBe(0);
      // a WAL write that committed nothing new (a checkpoint) pushes nothing
      v.live.handleChange(v.wal); await sleep(30);
      expect(v.writes).toHaveLength(1);
    } finally { v.done(); }
  });

  test("log/ is not watched: an append by hand waits for recovery, an engine write commits", async () => {
    const v = viewer();
    try {
      v.live.start(); await sleep(10);
      expect(WATCHED.has("log")).toBe(false);
      const byHand = appendSourceInsertionEvent(v.root, insertion({ id: `ins_${"c".repeat(24)}`, source_id: "c" }));
      v.live.handleChange(byHand.path); await sleep(30);
      expect(v.writes).toEqual([]);
      expect(v.recoveries()).toBe(1); // boot only
    } finally { v.done(); }
  });

  test("a commit whose WAL wake-up was missed is caught by the backstop", async () => {
    const v = viewer(20);
    try {
      v.live.start(); await sleep(10);
      const landed = insertion({ id: `ins_${"d".repeat(24)}`, source_id: "d" });
      appendSourceInsertionEvent(v.root, landed); projectSourceInsertion(v.root, landed);
      await sleep(80); // no handleChange: nothing named the WAL
      expect(v.writes.filter((w) => w.startsWith("event: views\n"))).toHaveLength(1);
    } finally { v.done(); }
  });
});

describe("projectionWake", () => {
  test("data_version moves with each commit from another connection, and with a projection replaced", () => {
    const root = mdVault();
    const wake = projectionWake(root);
    try {
      expect(wake.moved()).toBe(false); // no projection yet: nothing to hear
      synced(root);
      expect(wake.moved()).toBe(true); // it appeared
      expect(wake.moved()).toBe(false);
      const landed = insertion({ id: `ins_${"e".repeat(24)}`, source_id: "e" });
      appendSourceInsertionEvent(root, landed); projectSourceInsertion(root, landed);
      expect(wake.moved()).toBe(true);
      expect(wake.moved()).toBe(false);
      // .state deleted and the projection rebuilt under the held connection
      rmSync(join(root, ".state"), { recursive: true, force: true });
      synced(root);
      expect(wake.moved()).toBe(true);
    } finally { wake.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("recoverInBackground", () => {
  test("heals a hand-written log file in a worker and says the projection moved", async () => {
    const root = mdVault();
    try {
      appendSourceInsertionEvent(root, insertion({ id: `ins_${"a".repeat(24)}`, source_id: "a" }));
      expect(synced(root).sources).toBe(1);
      appendSourceInsertionEvent(root, insertion({ id: `ins_${"b".repeat(24)}`, source_id: "b" }));
      expect(synced(root).sources).toBe(1); // no read takes the census
      expect(await recoverInBackground(root)).toBe(true);
      expect(synced(root).sources).toBe(2);
      expect(await recoverInBackground(root)).toBe(false); // nothing left to heal
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
