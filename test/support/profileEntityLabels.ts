/** Scratch-only label-guard profile; no model calls or real vault access.
 * bun test/support/profileEntityLabels.ts <engine> <output.json> */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const engine = resolve(process.argv[2]!);
const mod = (name: string) => import(join(engine, "lib", `${name}.ts`));
const { insertion } = await import(join(engine, "test/support/vault.ts"));
const { appendSourceInsertionEvent } = await mod("insertionLog");
const { appendAssertionEvent, createAssertionEvent, assertionEntityId } = await mod("assertionLog");
const { syncAssertionProjection, projectedLabelRows } = await mod("assertionProjection");
const agent = await mod("assertionAgent");
const root = mkdtempSync(join(tmpdir(), "bb-label-profile-"));
process.env.BIGBRAIN_ASSERTION_DB = join(root, ".state/assertions.db");
try {
  const source = insertion(); appendSourceInsertionEvent(root, source);
  const sources = new Map([[source.id, source]]);
  const entities = Array.from({ length: 500 }, (_, i) => ({ id: assertionEntityId(`Existing entity ${i}`), label: `Existing entity ${i}` }));
  for (let i = 0; i < 10_000; i++) {
    const pair = [entities[i % 500], entities[(i + 1) % 500]];
    appendAssertionEvent(root, createAssertionEvent({ text: `${pair.map(e => `[[${e.id}|${e.label}]]`).join(" and ")} have finding ${i}.`,
      entities: pair, sources: [source.id], author: { kind: "agent", id: "fixture" }, confidence: "direct",
      created_at: "2026-09-20T00:00:00Z", produced_by: { procedure: "fixture", version: "1" } }, sources));
  }
  syncAssertionProjection(root);
  const rowStart = performance.now(), rows = projectedLabelRows(root), rowsMs = performance.now() - rowStart;
  const samples = [], digests = [];
  for (let run = 0; run < 5; run++) {
    const canonicalize = agent.createAssertionLinkCanonicalizer?.(root) ?? ((text: string) => agent.canonicalizeAssertionLinks(root, text));
    const start = performance.now();
    const values = Array.from({ length: 40 }, (_, i) => canonicalize(`[[Fresh discovery ${i + 10_000}]] was reported.`));
    samples.push(performance.now() - start);
    digests.push(createHash("sha256").update(JSON.stringify(values)).digest("hex"));
  }
  const result = { assertions: 10_000, links: 20_000, entities: rows.length, batch: 40, rowsMs, samplesMs: samples, digests: [...new Set(digests)] };
  writeFileSync(process.argv[3]!, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally { rmSync(root, { recursive: true, force: true }); }
