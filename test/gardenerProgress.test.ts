import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeVault, insertion } from "./support/vault";
import { acquireAssertionLock } from "../lib/assertionAgent";
import { GARDENER_PROGRESS_DIR, GARDENER_PROGRESS_PATH, readGardenerProgress, startGardenerProgress } from "../lib/gardenerProgress";
import type { Hold } from "../lib/sqliteLock";
import { observeTools } from "../lib/run/toolActivity";
import { machineTools } from "../lib/run/machineTools";
import { createLive, defaultLiveWatch, type LiveWatchFn } from "../lib/liveEvents";
const roots: string[] = [], holds: Hold[] = [];
afterEach(() => {
  for (const hold of holds.splice(0)) hold.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const item = insertion({ body: "Ada prefers short notes." }), root = nativeVault({ insertions: [item] }), lock = acquireAssertionLock(root)!;
  roots.push(root); expect(lock).not.toBeNull(); holds.push(lock);
  return { root, item, lock };
}

test("shared tools publish safe counts, actual first filing, retries and no content", async () => {
  const { root, item } = fixture();
  let now = Date.parse("2026-09-20T00:00:00Z");
  const progress = startGardenerProgress(root, () => now);
  const tools = observeTools(machineTools(root, "tend"), progress.observe);
  const call = (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.call(args);
  expect(readGardenerProgress(root)?.phase).toBe("starting");
  await call("next", { kinds: ["intake", "staged"], limit: 3 });
  expect(readGardenerProgress(root)).toMatchObject({ phase: "reviewing", batch: 1, batches: 1, waitingForModel: true });
  now += 2000;
  await call("submit", { items: [{ submit: "assertion", text: "[[new:Ada]] prefers short notes.", sources: [item.id], confidence: "direct" }] });
  expect(readGardenerProgress(root)).toMatchObject({ claims: 1, firstFilingMs: 2000 });
  await call("submit", { items: [{ submit: "assertion", text: "No entity link", sources: [item.id], confidence: "direct" }] });
  expect(readGardenerProgress(root)).toMatchObject({ phase: "retrying", claims: 1, rejected: 1 });
  await call("next", { kinds: ["intake", "staged"] });
  expect(readGardenerProgress(root)).toMatchObject({ phase: "finishing", batch: 0 });
  const stored = readFileSync(join(root, GARDENER_PROGRESS_PATH), "utf8");
  expect(stored).not.toContain("Ada"); expect(stored).not.toContain(item.id); expect(stored).not.toContain(root);
  progress.finish(); expect(readGardenerProgress(root)).toBeNull();
});

test("declines, failed items and deduplicated claims never count as new claims", () => {
  const { root } = fixture(), progress = startGardenerProgress(root);
  progress.observe({ name: "submit", phase: "complete", args: { items: [{ submit: "decline" }, { submit: "assertion" }, { submit: "assertion" }] },
    result: { results: [{ index: 0, ok: true }, { index: 1, ok: true, deduped: true }, { index: 2, ok: false }], rejected: 1 } });
  expect(readGardenerProgress(root)).toMatchObject({ claims: 0, firstFilingMs: null, rejected: 1 });
});

test("status cannot survive its lock owner, and observer failure cannot fail a tool", async () => {
  const { root, lock } = fixture(); startGardenerProgress(root);
  expect(readGardenerProgress(root)).not.toBeNull();
  writeFileSync(join(root, ".state", "assertion.lock.holder"), `${JSON.stringify({ pid: 999999999 })}\n`); // another run's
  expect(readGardenerProgress(root)).toBeNull();
  lock.release();
  expect(readGardenerProgress(root)).toBeNull();
  const [tool] = observeTools([{ name: "test", description: "", inputSchema: {}, call: () => 42 }], () => { throw Error("status failed"); });
  expect(await tool!.call({})).toBe(42);
});

test("progress events update SSE without warming or invalidating graph content", async () => {
  const { root } = fixture(), progress = startGardenerProgress(root);
  let refresh = 0, warm = 0; const writes: string[] = [];
  const live = createLive({ root, refresh: () => { refresh++; }, warmLayout: () => { warm++; } });
  live.addClient({ write: text => writes.push(text) });
  expect(writes[0]).toContain("event: gardener");
  progress.observe({ name: "next", phase: "start", args: {} });
  live.handleChange(GARDENER_PROGRESS_PATH);
  await Bun.sleep(130);
  expect(writes.at(-1)).toContain('"phase":"checking"');
  expect(writes.filter(text => text.startsWith("event: views"))).toHaveLength(1); // the connection's, no push
  expect([refresh, warm]).toEqual([0, 0]);
  progress.finish(); live.handleChange(GARDENER_PROGRESS_PATH);
  await Bun.sleep(130);
  expect(writes.at(-1)).toBe("event: gardener\ndata: null\n\n");
  live.stop();
});

test("a vanished progress temp file reconciles the status without treating it as vault content", async () => {
  const { root } = fixture();
  let refreshes = 0, recoveries = 0, warms = 0;
  let fail!: Parameters<LiveWatchFn>[2];
  const writes: string[] = [];
  const live = createLive({ root, refresh: () => { refreshes++; }, recover: async () => { recoveries++; return false; }, warmLayout: () => { warms++; }, heartbeatMs: 60_000,
    watch: (_root, _change, onError) => { fail = onError; return { close() {} }; } });
  live.addClient({ write: text => writes.push(text) }); live.start();
  try {
    const progress = startGardenerProgress(root);
    fail(Object.assign(new Error("temp file already renamed"), { code: "ENOENT", path: join(root, GARDENER_PROGRESS_DIR, ".tmp-gone") }));
    await Bun.sleep(130);
    expect(writes.at(-1)).toContain('"phase":"starting"');
    progress.finish();
    fail(Object.assign(new Error("progress removed"), { code: "ENOENT", path: join(root, GARDENER_PROGRESS_PATH) }));
    await Bun.sleep(130);
    expect(writes.at(-1)).toBe("event: gardener\ndata: null\n\n");
    expect([recoveries, refreshes, warms]).toEqual([1, 0, 0]);
    expect(writes.filter(text => text.startsWith("event: views"))).toHaveLength(1); // the connection's, no push
  } finally { live.stop(); }
});

test("the real filesystem watcher forwards atomic progress changes independently of vault changes", async () => {
  const { root } = fixture();
  let refreshes = 0, recoveries = 0, warms = 0;
  const paths: string[] = [], errors: string[] = [];
  let subscriptions = 0;
  const started = performance.now();
  const live = createLive({ root, refresh: () => { refreshes++; }, recover: async () => { recoveries++; return false; }, warmLayout: () => { warms++; }, heartbeatMs: 60000,
    watch: (root, onChange, onError) => {
      subscriptions++;
      try {
        return defaultLiveWatch(root, rel => { paths.push(rel); onChange(rel); }, error => { errors.push(String(error)); onError(error); });
      } catch (error) { errors.push(String(error)); throw error; }
    }, log: message => errors.push(message) });
  const writes: string[] = [];
  let arrived!: () => void;
  const next = new Promise<void>(resolve => { arrived = resolve; });
  live.addClient({ write: text => { writes.push(text); if (paths.length && text.includes('"phase":"starting"')) arrived(); } });
  live.start();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // Do not assume recursive watch delivery is ready the instant start()
  // returns. Keep publishing atomic updates until a real notification arrives;
  // the 60s heartbeat cannot satisfy this test's 2s deadline.
  let publications = 0;
  const publish = () => { publications++; startGardenerProgress(root); };
  const updates = setInterval(publish, 25);
  try {
    publish();
    await Promise.race([next, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(`Progress did not arrive: ${JSON.stringify({
      publications, subscriptions, paths: paths.slice(-40), errors, status: readGardenerProgress(root), writes,
    })}`)), 2000); })]);
    expect(paths.length).toBeGreaterThan(0); // Recovery hints alone cannot pass.
    expect([recoveries, refreshes, warms]).toEqual([1, 0, 0]);
    expect(writes.filter(text => text.startsWith("event: views"))).toHaveLength(1); // the connection's, no push
    if (errors.length) console.info("Native progress watcher recovered:", JSON.stringify({
      subscriptions, errors, publications, nativeEvents: paths.length, deliveryMs: performance.now() - started,
    }));
  } finally { clearInterval(updates); if (timeout) clearTimeout(timeout); live.stop(); }
});
