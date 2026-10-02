/** #6/#10: a refresh begun before the event stream's first snapshot, joined by that
 * snapshot's own refresh, must not read as an engine restart and turn on polling. */
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileModule } from "../web/ui/node_modules/svelte/compiler";

// The production client modules, compiled with their Svelte runes (as in pilotDeliveryClient).
const dir = mkdtempSync(join(tmpdir(), "bb-epoch-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "support/workEpochHarness.ts")],
  outdir: dir, target: "browser", conditions: ["browser"],
  plugins: [{ name: "svelte-runes", setup(build) {
    build.onResolve({ filter: /^svelte(?:\/|$)/ }, ({ path }) => ({
      path: path === "svelte" ? join(import.meta.dir, "../web/ui/node_modules/svelte/src/index-client.js")
        : Bun.resolveSync(path, join(import.meta.dir, "../web/ui")),
    }));
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const source = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text());
      return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
    });
  } }],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const { applicationCursor, receiveApplicationChange, subscribeApplication, updatePump, refreshWork, work } =
  await import(build.outputs[0]!.path) as typeof import("./support/workEpochHarness");

const oldFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = oldFetch; });
const at = new Date(2026, 0, 1).toISOString();
const summary = (updated: string) => ({ id: `work-${"a".repeat(32)}`, title: "Fixture", status: "idle", provider: "pi", model: "fixture", created: at, updated, revision: updated === at ? 1 : 2 });

test("the first connect snapshot joins a pre-connect refresh without disconnecting, and reads fresh data", async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path === "/api/vault") return Response.json({});
    if (!path.startsWith("/api/pilot/work")) throw new Error(`unexpected ${path}`);
    // The first read (the page's mount poll) is still in flight when the stream connects.
    if (++calls === 1) { await gate; return Response.json({ sessions: [summary(at)] }); }
    return Response.json({ sessions: [summary("2026-01-01T00:00:01.000Z")] });
  }) as typeof fetch;
  expect(applicationCursor.epoch).toBe("");
  const poll = refreshWork();
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
  // The stream's connect snapshot arrives; its pump refresh joins the single flight.
  const pump = updatePump(async () => { await refreshWork(); });
  const unsubscribe = subscribeApplication(update => { void pump.push(update); });
  receiveApplicationChange({ epoch: "fixture-epoch", revision: 0, snapshot: true, entities: [] });
  release();
  await poll; await new Promise(resolve => setTimeout(resolve, 10));
  unsubscribe(); pump.stop();
  expect(work.error).toBe("");
  expect(applicationCursor.connected).toBe(true);
  // The pre-connect read predates the subscription, so it is read again.
  expect(calls).toBe(2);
  expect(work.sessions.map(s => s.updated)).toEqual(["2026-01-01T00:00:01.000Z"]);
  // A genuine later restart is still refused.
  receiveApplicationChange({ epoch: "fixture-epoch", revision: 1, entities: [] });
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url) === "/api/vault") return Response.json({});
    receiveApplicationChange({ epoch: "restarted-epoch", revision: 0, snapshot: true, entities: [] });
    return Response.json({ sessions: [] });
  }) as typeof fetch;
  await refreshWork();
  expect(work.error).toMatch(/engine restarted/);
});
