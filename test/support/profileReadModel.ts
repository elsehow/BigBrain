/** Synthetic, reproducible cross-checkout comparison. No models or personal data.
 * bun test/support/profileReadModel.ts <engine-checkout> <output.json>
 * Each process builds the same fixture and measures cold, warm, and invalidated reads. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const engine = resolve(process.argv[2]!);
const mod = (path: string) => import(join(engine, path));
const { insertion } = await mod("test/support/vault.ts");
const { appendSourceInsertionEvent } = await mod("lib/insertionLog.ts");
const { createAssertionEvent, appendAssertionEvent, assertionEntityId } = await mod("lib/assertionLog.ts");
const { syncAssertionProjection } = await mod("lib/assertionProjection.ts");
const { buildAssertionGraph } = await mod("lib/assertionGraph.ts");
const { assertionEntityView, assertionEntityPath, invalidateAssertionRecord } = await mod("lib/assertionEntityView.ts");
const { recentSourcePage } = await mod("lib/sourceFeed.ts");
// Compare the actual viewer wrapper too: the baseline already cached its
// complete feed, even though Pilot called the uncached helper directly.
const viewer = existsSync(join(engine, "lib/recentCache.ts")) ? await mod("lib/recentCache.ts") : undefined;
const viewerFeed = viewer?.recentSourcePageCached ?? recentSourcePage;
const invalidateFeed = viewer?.invalidateRecentCache ?? invalidateAssertionRecord;
const { scanSurface } = await mod("lib/searchCore.ts");
const root = mkdtempSync(join(tmpdir(), "bb-read-model-profile-"));
process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
const results: Record<string, unknown> = { bun: Bun.version, platform: process.platform, arch: process.arch, sources: 1200, assertions: 3600, markdown: 60 };
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
try {
  mkdirSync(join(root, "memory"));
  const entities = Array.from({ length: 120 }, (_, i) => ({ id: assertionEntityId(`Project ${i}`), label: `Project ${i}` }));
  const sources = Array.from({ length: 1200 }, (_, i) => insertion({
    id: `ins_${i.toString(16).padStart(24,"0")}`, source_id: `source-${i}`, title: `Project discussion ${i}`,
    body: (`Project ${i % 120} discusses [[${entities[i % 120].id}|the project]]. `).repeat(40),
    received_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    envelope: { type: "reference", kind: "web-clip", source: "api" },
  }));
  for (const source of sources) appendSourceInsertionEvent(root, source);
  const byId = new Map(sources.map(s => [s.id, s]));
  for (let i = 0; i < 3600; i++) {
    const entity = entities[i % 120];
    appendAssertionEvent(root, createAssertionEvent({ text: `[[${entity.id}|${entity.label}]] has finding ${i}.`, entities: [entity],
      sources: [sources[i % sources.length].id], author: { kind: "agent", id: "fixture" }, confidence: "direct",
      created_at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString(), produced_by: { procedure: "fixture", version: "1" } }, byId));
  }
  for (let i = 0; i < 60; i++) writeFileSync(join(root, "memory", `topic-${i}.md`), `# Topic ${i}\n\n[[${entities[i].id}|Project ${i}]]\n`);
  const syncStarted = performance.now();
  syncAssertionProjection(root);
  results.initialProjectionMs = performance.now() - syncStarted;
  const measure = (name: string, fn: () => unknown) => {
    const samples: number[] = [], hashes: string[] = [];
    for (let i = 0; i < 6; i++) { const start = performance.now(); const value = fn(); samples.push(performance.now() - start); hashes.push(digest(value)); }
    results[name] = { coldMs: samples[0], warmMedianMs: samples.slice(1).sort((a,b)=>a-b)[2], samplesMs: samples, digests: [...new Set(hashes)] };
  };
  measure("viewerFeed", () => viewerFeed(root, 0, 20));
  measure("pilotFeed", () => recentSourcePage(root, 0, 20));
  measure("entity", () => assertionEntityView(root, assertionEntityPath(entities[0].id)));
  measure("search", () => scanSurface(root, "Project 12", 20, "api", { ledger: false }));
  measure("graph", () => { const evidence: unknown[] = []; const graph = buildAssertionGraph(root, (...args: unknown[]) => evidence.push(args)); return { graph, evidence }; });
  appendSourceInsertionEvent(root, insertion({ id: `ins_${"f".repeat(24)}`, source_id: "late", title: "Later source", received_at: "2026-09-20T00:00:00Z" }));
  invalidateAssertionRecord(root);
  invalidateFeed(root);
  measure("changedFeed", () => viewerFeed(root, 0, 20));
  measure("changedGraph", () => { const evidence: unknown[] = []; const graph = buildAssertionGraph(root, (...args: unknown[]) => evidence.push(args)); return { graph, evidence }; });
  Bun.gc(true);
  results.memoryAfterGC = process.memoryUsage();
  results.projectionBytes = statSync(join(root, ".state", "assertions.db")).size;
  writeFileSync(process.argv[3]!, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
