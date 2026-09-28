import { describe, expect, test } from "bun:test";
import { swrEffect } from "../web/ui/src/lib/swrEffect";

describe("swrEffect", () => {
  test("no cached value: only the fresh landing calls onValue", async () => {
    const seen: number[] = [];
    swrEffect({ cached: undefined, fresh: Promise.resolve(1) }, (v) => seen.push(v));
    await Promise.resolve().then(() => Promise.resolve()); // let the .then chain settle
    expect(seen).toEqual([1]);
  });

  test("a cached value paints synchronously, then the fresh landing repaints", async () => {
    const seen: number[] = [];
    swrEffect({ cached: 0, fresh: Promise.resolve(1) }, (v) => seen.push(v));
    expect(seen).toEqual([0]); // synchronous — no await needed for the cached branch
    await Promise.resolve().then(() => Promise.resolve());
    expect(seen).toEqual([0, 1]);
  });

  test("skipCached suppresses the cached paint but not the fresh one — the already-loaded guard", async () => {
    const seen: number[] = [];
    swrEffect({ cached: 0, fresh: Promise.resolve(1) }, (v) => seen.push(v), { skipCached: true });
    expect(seen).toEqual([]);
    await Promise.resolve().then(() => Promise.resolve());
    expect(seen).toEqual([1]);
  });

  test("a rejected fresh fetch calls onError when given one, and never throws otherwise", async () => {
    const errs: unknown[] = [];
    swrEffect({ cached: undefined, fresh: Promise.reject(new Error("network")) }, () => {}, {
      onError: (e) => errs.push(e),
    });
    await Promise.resolve().then(() => Promise.resolve());
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe("network");
  });

  test("a rejected fetch with no onError is swallowed, not an unhandled rejection", async () => {
    // If this were unhandled, bun:test's global rejection handler would fail
    // the run — the absence of a thrown/unhandled error IS the assertion.
    swrEffect({ cached: undefined, fresh: Promise.reject(new Error("quiet")) }, () => {});
    await Promise.resolve().then(() => Promise.resolve());
  });

  test("cached value 0/empty-string/false still paint — only undefined is 'nothing cached'", async () => {
    const seen: (number | string | boolean)[] = [];
    swrEffect({ cached: 0, fresh: new Promise(() => {}) }, (v) => seen.push(v));
    expect(seen).toEqual([0]);
  });
});
