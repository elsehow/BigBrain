/** Cross-checkout scratch benchmark, with no model/provider calls.
 * bun test/support/profileCompactReaders.ts <engine> <graph|feed|shared> <output.json> [decode] */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const engine = resolve(process.argv[2]!), operation = process.argv[3]!, decodeOnly = process.argv[5] === "decode";
const mod = (file: string) => import(join(engine, "lib", `${file}.ts`));
const { insertion } = await import(join(engine, "test/support/vault.ts"));
const { appendSourceInsertionEvent } = await mod("insertionLog");
const { createAssertionEvent, appendAssertionEvent, assertionEntityId } = await mod("assertionLog");
const { syncAssertionProjection } = await mod("assertionProjection");
const { buildAssertionGraph } = await mod("assertionGraph");
const { recentSourcePage } = await mod("sourceFeed");
const { TRANSCRIPT_MARK, renderTurns } = await mod("transcriptProjection");
const root = mkdtempSync(join(tmpdir(), "bb-compact-readers-"));
const db = process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state/assertions.db");
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
try {
  const entities = Array.from({ length: 120 }, (_, i) => ({ id: assertionEntityId(`Project ${i}`), label: `Project ${i}` }));
  const sources = Array.from({ length: 1200 }, (_, i) => {
    const entity = entities[i % entities.length];
    const text = `Opening context for item ${i}.\n\n[[${entity.id}|${entity.label}]] has evidence.\n\n`
      + "Detailed source content with Unicode: café 🙂. ".repeat(650)
      + `\n\nSee [the memory](memory/topic-${i % 60}.md) and [[${entities[(i+1) % entities.length].id}]].\n\n\`\`\`md\n[example](ignored.md)\n\`\`\`\n`;
    const transcript = `${TRANSCRIPT_MARK}\n\n${renderTurns([
      { speaker: "user", text: "First question" }, { speaker: "assistant", text },
      { speaker: "user", text: "Second question" }, { speaker: "user", text: "Third question" },
    ])}`;
    return insertion({ id: `ins_${i.toString(16).padStart(24, "0")}`, source_id: `source-${i}`,
      title: i < 800 ? `Project ${Math.floor(i / 4)} quarterly planning conversation` : `Source ${i}`,
      body: i < 1000 ? text : transcript,
      received_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      envelope: i < 800 ? { source: "email", kind: "email", inbox: "fixture@example.com" }
        : i < 1000 ? { source: "api", kind: "web-clip" } : { source: "agent-chat", kind: "agent-chat", key: `session-${i}` },
    });
  });
  for (const source of sources) appendSourceInsertionEvent(root, source);
  const byId = new Map(sources.map(s => [s.id, s]));
  for (let i = 0; i < 1200; i++) {
    const entity = entities[i % entities.length];
    appendAssertionEvent(root, createAssertionEvent({ text: `[[${entity.id}|${entity.label}]] has finding ${i}.`,
      entities: [entity], sources: [sources[i].id], author: { kind: "agent", id: "fixture" }, confidence: "direct",
      created_at: sources[i].received_at, produced_by: { procedure: "fixture", version: "1" } }, byId));
  }
  mkdirSync(join(root, "memory"));
  for (let i = 0; i < 60; i++) writeFileSync(join(root, "memory", `topic-${i}.md`), `# Topic ${i}\n\n[[${entities[i].id}|Project ${i}]]\n`);
  const sourceBodyBytes = sources.reduce((n,s) => n + Buffer.byteLength(s.body), 0);
  sources.length = 0; byId.clear();
  const syncStart = performance.now(); syncAssertionProjection(root); const projectionMs = performance.now() - syncStart;
  const graphRead = () => {
    const evidence: unknown[] = []; const graph = buildAssertionGraph(root, (...args: unknown[]) => evidence.push(args)); return { graph, evidence };
  };
  const read = operation === "graph" ? graphRead : operation === "feed" ? () => recentSourcePage(root, 0, 20)
    : operation === "shared" ? () => ({ feed: recentSourcePage(root, 0, 20), ...graphRead() }) : undefined;
  if (!read) throw new Error(`Unknown operation: ${operation}`);
  const parse = JSON.parse;
  function measure() {
    const decoded = { calls: 0, jsonBytes: 0, sourceBodies: 0, sourceBodyBytes: 0, assertions: 0, markdown: 0, linkSets: 0 };
    if (decodeOnly) JSON.parse = (text, reviver) => {
      const value = parse(text, reviver); decoded.calls++; decoded.jsonBytes += Buffer.byteLength(text);
      if (value?.event === "source.inserted" && typeof value.body === "string") {
        decoded.sourceBodies++; decoded.sourceBodyBytes += Buffer.byteLength(value.body);
      }
      if (value?.event === "assertion.asserted") decoded.assertions++;
      if (typeof value?.path === "string" && value.path.startsWith("memory/")) decoded.markdown++;
      if (Array.isArray(value) && value.some(v => typeof v?.target === "string")) decoded.linkSets++;
      return value;
    };
    Bun.gc(true); const before = process.memoryUsage(), samples: number[] = [], digests: string[] = [];
    try {
      for (let i = 0; i < (decodeOnly ? 1 : 6); i++) {
        const start = performance.now(), result = read!(); samples.push(performance.now() - start); digests.push(digest(result));
      }
    } finally { JSON.parse = parse; }
    Bun.gc(true);
    return { samplesMs: samples, firstMs: samples[0], warmMedianMs: samples.slice(1).sort((a,b) => a-b)[2],
      digests: [...new Set(digests)], before, after: process.memoryUsage(), ...(decodeOnly ? { decoded } : {}) };
  }
  const initial = measure();
  appendSourceInsertionEvent(root, insertion({ id: `ins_${"f".repeat(24)}`, source_id: "late", title: "Later source", received_at: "2026-09-20T00:00:00Z" }));
  const changed = measure();
  const result = { operation, bun: Bun.version, sources: 1200, assertions: 1200, markdown: 60, sourceBodyBytes,
    projectionMs, initial, changed, databaseBytes: statSync(db).size,
    ...(operation === "feed" ? { completeFeedDigest: digest(recentSourcePage(root, 0, 2000)) } : {}) };
  writeFileSync(process.argv[4]!, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ operation, first: initial.firstMs, warm: initial.warmMedianMs, changed: changed.firstMs }));
} finally { rmSync(root, { recursive: true, force: true }); }
