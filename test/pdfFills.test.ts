import { describe, expect, test } from "bun:test";

/**
 * The viewer's pdf.js is the LEGACY build (web/ui/src/lib/pdf.ts): pdf.js
 * 6 calls `Map.prototype.getOrInsertComputed` unguarded, in the main module
 * and in the worker, and a WebKit without it failed every PDF drop at the
 * end of the walk — Dana, 2026-09-03. The legacy build carries core-js
 * fills for both; the platform gap (ReadableStream iteration, #715) stays
 * ours. Each case runs the probe in a child Bun, because the probe deletes
 * built-ins before loading a build — see test/support/pdfFillsProbe.ts.
 */
type Probe = {
  ok: boolean;
  error?: string;
  before: Record<string, string>;
  after: Record<string, string>;
  text?: string;
  pages?: number;
  title?: string;
  author?: string;
  created?: string;
  thin?: boolean;
};

function probe(mode: "legacy" | "standard" | "worker"): Probe {
  const r = Bun.spawnSync([process.execPath, new URL("./support/pdfFillsProbe.ts", import.meta.url).pathname, mode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = r.stdout.toString().trim().split("\n");
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Probe;
}

describe("the viewer's pdf.js build fills what an older WebKit lacks", () => {
  test("legacy build: upsert restored on both Map and WeakMap, the whole walk lands, metadata included", () => {
    const p = probe("legacy");
    expect(p.before).toEqual({ map: "undefined", weakmap: "undefined" });
    expect(p.ok, p.error).toBe(true);
    expect(p.after).toEqual({ map: "function", weakmap: "function" });
    expect(p.pages).toBe(2);
    expect(p.text).toBe("Page one of the fixture.\n\n---\n\nPage two of the fixture.");
    expect(p.title).toBe("Fixture");
    expect(p.author).toBe("Dana");
    expect(p.created).toBe("2026-09-03");
    expect(p.thin).toBe(true);
  });

  test("the legacy worker module brings its own fill — the main thread's cannot reach it", () => {
    const p = probe("worker");
    expect(p.ok, p.error).toBe(true);
    expect(p.before["map"]).toBe("undefined");
    expect(p.after["map"]).toBe("function");
    expect(p.after["weakmap"]).toBe("function");
  });

  test("control — the default build brings no fill", () => {
    // Its module cannot even evaluate under Bun ("DOMMatrix is not defined";
    // pdf.js itself says to use legacy off the browser), so `ok` is not the
    // claim here — only that nothing it loads puts upsert back.
    const p = probe("standard");
    expect(p.before["map"]).toBe("undefined");
    expect(p.after).toEqual({ map: "undefined", weakmap: "undefined" });
  });
});
