/** Scratch-only cross-checkout graph freshness/hot-path benchmark.
 * bun test/support/profileReadFreshness.ts <engine> <sync|async> <output.json> */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const engine = resolve(process.argv[2]!), mode = process.argv[3]!;
if (!["sync", "async"].includes(mode)) throw Error("Expected sync or async");
const { insertion } = await import(join(engine, "test/support/vault.ts"));
const { appendSourceInsertionEvent, insertionEventRel } = await import(join(engine, "lib/insertionLog.ts"));
const { syncAssertionProjection } = await import(join(engine, "lib/assertionProjection.ts"));
const { assertionGraphEvidenceCached, assertionGraphEvidenceAsync } = await import(join(engine, "lib/graphCache.ts"));
const root = mkdtempSync(join(tmpdir(), "bb-read-freshness-"));
process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state/assertions.db");
const realNow = Date.now;
let clock = realNow();
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value: any) => createHash("sha256").update(JSON.stringify(canonical({ graph: value.graph, connections: value.connections }))).digest("hex");
try {
  for (let i = 0; i < 1200; i++) appendSourceInsertionEvent(root, insertion({
    id: `ins_${i.toString(16).padStart(24, "0")}`, source_id: `source-${i}`, title: `Source ${i}`,
    received_at: "2026-09-20T00:00:00Z", body: "A synthetic arrival with enough detail to file.",
  }));
  syncAssertionProjection(root);
  // Freeze only the census clock so hot samples never accidentally include a
  // periodic check. Worker clocks stay real; elapsed latency uses performance.now.
  Date.now = () => clock;
  const read = mode === "sync" ? assertionGraphEvidenceCached : assertionGraphEvidenceAsync;
  const timed = async () => {
    let ticks = 0; const pulse = setInterval(() => ticks++, 1);
    const start = performance.now();
    try { const value = await read(root); return { value, ms: performance.now() - start, ticks }; }
    finally { clearInterval(pulse); }
  };
  const initial = await timed(), samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const start = performance.now(), result = await read(root);
    samples.push(performance.now() - start);
    if (result !== initial.value) throw Error("Hot reader rebuilt the graph");
  }
  const second = insertion({ id: `ins_${"f".repeat(24)}`, source_id: "missed", title: "Missed arrival", received_at: "2026-09-20T01:00:00Z" });
  const path = join(root, insertionEventRel(second));
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(second));
  clock += 1100;
  const missed = await timed();
  const visible = (result: any) => result.graph.nodes.some((node: any) => node.id === `source:${second.id}`);
  let latest = missed, discoveredAfterMs = 1100;
  if (!visible(latest.value)) { clock += 60000; discoveredAfterMs += 60000; latest = await timed(); }
  if (!visible(latest.value)) throw Error("Arrival was never discovered");
  clock += 61000;
  const unchanged = await timed();
  const sorted = [...samples].sort((a,b) => a-b);
  const result = { mode, bun: Bun.version, sources: 1200, initialMs: initial.ms,
    hotMedianMs: sorted[100], hotP95Ms: sorted[190], hotSamplesMs: samples,
    missedHint: { ms: missed.ms, visible: visible(missed.value), eventLoopTicks: missed.ticks },
    discoveredAfterMs, discoveryMs: latest.ms,
    unchanged: { ms: unchanged.ms, reused: unchanged.value === latest.value, eventLoopTicks: unchanged.ticks },
    digests: { initial: digest(initial.value), latest: digest(latest.value), unchanged: digest(unchanged.value) } };
  writeFileSync(process.argv[4]!, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ mode, hotMedianMs: result.hotMedianMs, missedHint: result.missedHint, unchanged: result.unchanged }));
} finally { Date.now = realNow; rmSync(root, { recursive: true, force: true }); }
