/** Scratch-only direct HTTP feed profile, without graph startup warming.
 * bun test/support/profileDirectFeed.ts <engine> <output.json> [sources=1200] */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
const engine = resolve(process.argv[2]!), count = Number(process.argv[4] ?? 1200);
const root = mkdtempSync(join(tmpdir(), "bb-direct-feed-"));
process.env.BIGBRAIN_VAULT = root;
process.env.BIGBRAIN_ASSERTION_DB = join(root, ".state/assertions.db");
const { insertion } = await import(join(engine, "test/support/vault.ts"));
const { appendSourceInsertionEvent } = await import(join(engine, "lib/insertionLog.ts"));
const { ROUTES } = await import(join(engine, "web/server.ts"));
const { dispatch } = await import(join(engine, "lib/httpx.ts"));
const server = createServer((req, res) => {
  if (req.url === "/ping") { res.end("ok"); return; }
  if (!dispatch(ROUTES, req, res)) { res.writeHead(404); res.end(); }
});
try {
  for (let i = 0; i < count; i++) appendSourceInsertionEvent(root, insertion({
    id: `ins_${i.toString(16).padStart(24, "0")}`, source_id: `source-${i}`, title: `Source ${i}`,
    body: "Synthetic source content with Unicode: café 🙂. ".repeat(650),
    received_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const measure = async () => {
    let last = performance.now(), maxGapMs = 0, ticks = 0;
    const pulse = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; ticks++; }, 5);
    const start = performance.now();
    const ping = new Promise<number>(resolve => setTimeout(async () => {
      await (await fetch(`${url}/ping`)).text(); resolve(performance.now() - start);
    }, 1));
    const response = await fetch(`${url}/api/recent?limit=40`), text = await response.text();
    const ms = performance.now() - start;
    const pingMs = await ping;
    await new Promise(resolve => setTimeout(resolve, 10)); clearInterval(pulse);
    if (response.status !== 200) throw Error(text);
    return { ms, pingMs, maxGapMs, ticks, total: JSON.parse(text).total,
      digest: createHash("sha256").update(text).digest("hex") };
  };
  const firstEver = await measure();
  const warm = []; for (let i = 0; i < 5; i++) warm.push(await measure());
  appendSourceInsertionEvent(root, insertion({ id: `ins_${"f".repeat(24)}`, source_id: "late",
    title: "Later source", received_at: "2026-09-20T00:00:00Z" }));
  const changed = await measure();
  // A fresh reader process is unnecessary: invalidate shared freshness and
  // leave the persisted feed intact to measure a periodic census separately.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const unchangedCensus = await measure();
  const result = { sources: count, bun: Bun.version, firstEver, warm, changed, unchangedCensus };
  writeFileSync(process.argv[3]!, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); }
