/** Same marked scratch vault and builders in either checkout. Aggregate only.
 * Measures timer and concurrent HTTP delay during real watcher/layout work. */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
const [engineArg, rootArg, output] = process.argv.slice(2);
if (!engineArg || !rootArg || !output) throw Error("engine snapshot output required");
const engine = realpathSync(engineArg), root = realpathSync(rootArg);
if (!/^bb-(vault-scale|gardener-profile)-/.test(basename(root)) || !existsSync(join(root, ".benchmark-snapshot"))) throw Error("Marked scratch snapshot required");
if (process.env.BIGBRAIN_ASSERTION_DB || process.env.BIGBRAIN_SEARCH_DB) throw Error("External database overrides forbidden");
const cache = await import(join(engine, "lib/graphCache.ts"));
// Engines before the notes door (#225) needed a hint to drop decoded records; later ones key them by revision.
const invalidateAssertionRecord: (root: string) => void = (await import(join(engine, "lib/assertionEntityView.ts"))).invalidateAssertionRecord ?? (() => {});
const { createLive } = await import(join(engine, "lib/liveEvents.ts"));
const build = cache.primaryGraphAsync ?? cache.primaryGraphCached;
const layout = cache.graphWithLayoutAsync ?? cache.graphWithLayout;
const server = createServer((_req, res) => res.end("ok"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
// An independent client continues issuing requests while the server loop is
// blocked; a client scheduled on that same loop would miss the stall entirely.
const client = new Worker(`
  const { parentPort, workerData } = require("node:worker_threads");
  const { get } = require("node:http");
  let active = false, requests = [], polling;
  const ping = () => new Promise((resolve, reject) => {
    const start = performance.now();
    get(workerData, res => { res.resume(); res.on("end", () => { requests.push(performance.now() - start); resolve(); }); }).on("error", reject);
  });
  parentPort.on("message", async command => {
    if (command === "start") {
      active = true; requests = [];
      polling = (async () => { while (active) { await ping(); await new Promise(r => setTimeout(r, 10)); } })();
      parentPort.postMessage("started");
    } else {
      active = false; await polling; parentPort.postMessage(requests);
    }
  });
`, { eval: true, workerData: `http://127.0.0.1:${address.port}/` });
function command<T>(message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    client.once("error", failed);
    client.once("message", value => { client.off("error", failed); resolve(value); });
    client.postMessage(message);
  });
}
const samples: object[] = [];
async function measure(phase: string, job: () => Promise<unknown>) {
  await command("start");
  const delays: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); delays.push(Math.max(0, now - last - 10)); last = now; }, 10);
  const start = performance.now();
  try {
    const value = await job();
    const ms = performance.now() - start;
    await Bun.sleep(20);
    const requests = await command<number[]>("stop");
    samples.push({ phase, ms, maxTimerDelayMs: Math.max(0, ...delays), maxHttpMs: Math.max(0, ...requests), httpSamples: requests.length, rssMiB: process.memoryUsage().rss / 1048576 });
    return value;
  } finally { clearInterval(timer); }
}
const layoutPath = join(root, ".state", "graph-layout-assertions.json");
const savedLayout = existsSync(layoutPath) ? readFileSync(layoutPath) : undefined;
const probePath = join(root, "memory", "profile-graph-refresh.md");
if (existsSync(probePath)) throw Error("Probe already exists");
let live: ReturnType<typeof createLive> | undefined;
try {
  let graph;
  const digests: string[] = [];
  for (let i = 0; i < 3; i++) {
    cache.invalidateGraphCaches(root); invalidateAssertionRecord(root);
    graph = await measure("graph", () => Promise.resolve(build(root)));
    digests.push(createHash("sha256").update(JSON.stringify(graph)).digest("hex"));
  }
  rmSync(layoutPath, { force: true });
  await measure("cold-layout", () => Promise.resolve(layout(root, graph)));
  let changed: (() => void) | undefined;
  const pinged = new Promise<void>(resolve => { changed = resolve; });
  live = createLive({ root });
  live.addClient({ write(text: string) { if (text.includes('"changed":true')) changed?.(); } });
  live.start();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await measure("watcher-changed-layout", async () => {
      mkdirSync(join(root, "memory"), { recursive: true });
      const targets = graph.nodes.filter((n: { entity?: boolean }) => n.entity).slice(0, 2);
      writeFileSync(probePath, `# Disposable graph refresh probe\n\n${targets.map((n: { path: string }) => `[[${n.path}]]`).join(" ")}\n`);
      await Promise.race([pinged, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error("Watcher timed out")), 60000); })]);
      const updated = await build(root);
      if (!updated.nodes.some((n: { path: string }) => n.path === "memory/profile-graph-refresh.md")) throw Error("Fresh graph missing probe");
    });
  } finally { if (deadline) clearTimeout(deadline); }
  writeFileSync(output, JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length, digests, samples }, null, 2));
  console.log(JSON.stringify({ nodes: graph.nodes.length, samples }));
} finally {
  live?.stop(); rmSync(probePath, { force: true });
  if (savedLayout) { mkdirSync(join(root, ".state"), { recursive: true }); writeFileSync(layoutPath, savedLayout); }
  else rmSync(layoutPath, { force: true });
  await client.terminate();
  server.closeAllConnections(); server.close();
}
