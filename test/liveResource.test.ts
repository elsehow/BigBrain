import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileModule } from "../web/ui/node_modules/svelte/compiler";

const dir = mkdtempSync(join(tmpdir(), "bb-resource-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "support/liveResourceHarness.svelte.ts")],
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
const { resourceHarness } = await import(build.outputs[0]!.path) as typeof import("./support/liveResourceHarness.svelte");

test("live resources refresh once, retain fresh values, ignore obsolete results and clean up", async () => {
  const h = resourceHarness();
  try {
    expect(h.seen).toEqual([0]);
    h.requests[0]!.resolve(1); await h.settle();
    expect(h.seen).toEqual([0, 1]);
    expect(h.requests).toHaveLength(1); // callback state never triggers a fetch loop
    h.refresh();
    expect(h.seen).toEqual([0, 1]); // no rollback to cache
    h.select("b");
    h.requests[1]!.resolve(2); await h.settle();
    expect(h.seen).toEqual([0, 1, 10]); // old key cannot overwrite b
    h.requests[2]!.resolve(11); await h.settle();
    h.refresh(); h.refresh();
    h.requests[3]!.resolve(12); await h.settle();
    expect(h.seen.at(-1)).toBe(11); // old refresh of the SAME key is obsolete too
    h.requests[4]!.reject(new Error("offline")); await h.settle();
    expect(h.errors).toEqual([true]);
    h.select(null);
    expect(h.requests).toHaveLength(5);
    expect(h.resets).toEqual(["a", "b", null]);
    h.select("a");
    expect(h.seen.at(-1)).toBe(0);
    h.dispose();
    h.requests[5]!.resolve(99); await h.settle();
    expect(h.seen.at(-1)).toBe(0);
  } finally { h.dispose(); }
});
