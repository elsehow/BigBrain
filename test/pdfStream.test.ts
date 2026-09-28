import { describe, expect, test } from "bun:test";
import { ensureStreamAsyncIteration } from "../web/ui/src/lib/pdf";

// WebKit's missing ReadableStream async iteration, filled in before pdf.js
// loads (web/ui/src/lib/pdf.ts). Bun's own streams already iterate, so the
// shape is exercised on a bare object standing in for the prototype.
type Proto = { [Symbol.asyncIterator]?: unknown; values?: unknown };
const stream = (chunks: number[], onCancel?: () => void): ReadableStream<number> =>
  new ReadableStream<number>({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
    cancel: onCancel,
  });
type Values = (this: ReadableStream, opts?: { preventCancel?: boolean }) => AsyncIterable<unknown>;

describe("ensureStreamAsyncIteration", () => {
  test("a runtime that already has it is left alone", () => {
    expect(ensureStreamAsyncIteration()).toBe(false); // bun
    expect(ensureStreamAsyncIteration({ [Symbol.asyncIterator]: () => {} })).toBe(false);
  });

  test("installs Symbol.asyncIterator and values(), and they read the stream to its end", async () => {
    const proto: Proto = {};
    expect(ensureStreamAsyncIteration(proto)).toBe(true);
    expect(typeof proto[Symbol.asyncIterator]).toBe("function");
    expect(proto.values).toBe(proto[Symbol.asyncIterator]);
    const out: unknown[] = [];
    let cancelled = false;
    const s = stream([1, 2, 3], () => { cancelled = true; });
    for await (const v of (proto[Symbol.asyncIterator] as Values).call(s)) out.push(v);
    expect(out).toEqual([1, 2, 3]);
    expect(cancelled).toBe(false); // read to done: released, not cancelled
    expect(s.locked).toBe(false);
  });

  test("an early exit cancels the stream — unless preventCancel", async () => {
    const proto: Proto = {};
    ensureStreamAsyncIteration(proto);
    let cancelled = 0;
    const a = stream([1, 2, 3], () => { cancelled++; });
    for await (const v of (proto.values as Values).call(a)) { if (v === 1) break; }
    expect(cancelled).toBe(1);
    expect(a.locked).toBe(false);
    const b = stream([1, 2, 3], () => { cancelled++; });
    for await (const v of (proto.values as Values).call(b, { preventCancel: true })) { if (v === 1) break; }
    expect(cancelled).toBe(1);
    expect(b.locked).toBe(false);
  });

  test("a values() the runtime has is kept; only the iterator symbol is added", () => {
    const own = () => {};
    const proto: Proto = { values: own };
    ensureStreamAsyncIteration(proto);
    expect(proto.values).toBe(own);
    expect(typeof proto[Symbol.asyncIterator]).toBe("function");
  });
});
