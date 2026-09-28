import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../desktop/src-tauri/src/ui-diagnostics.js", import.meta.url), "utf8");
function fixture(mode = "on") {
  let now = 1000;
  const events = new Map<string, ((event: any) => void)[]>();
  const frames: (() => void)[] = [], timers: (() => void)[] = [];
  const samples: any[] = [];
  const listen = (type: string, fn: (event: any) => void) => events.set(type, [...events.get(type) ?? [], fn]);
  const window: any = { __BIGBRAIN_UI_DIAGNOSTICS_MODE__: mode, addEventListener: listen,
    __TAURI__: { core: { invoke: async (_: string, args: any) => { samples.push(args.sample); } } } };
  const document = { hidden: false, hasFocus: () => true, addEventListener: listen };
  runInNewContext(script, { window, document, performance: { now: () => now },
    setInterval: (fn: () => void) => timers.push(fn), requestAnimationFrame: (fn: () => void) => frames.push(fn) });
  return { window, document, samples, frames, timers,
    advance: (ms: number) => { now += ms; },
    fire: (type: string, extra = {}) => events.get(type)?.forEach(fn => fn({ type, isTrusted: true, timeStamp: now, ...extra })),
  };
}

test("input timing never records typed text, target content or error messages", () => {
  const f = fixture();
  f.fire("keydown", { key: "private text", target: { textContent: "private note" }, timeStamp: 850 });
  expect(f.samples[0]).toEqual({ event: "input_key", id: 1, values: [0, 150] });
  f.advance(20); f.frames.shift()!();
  f.advance(16); f.frames.shift()!();
  expect(f.samples.slice(1).map(s => s.values[0])).toEqual([20, 36]);
  f.fire("error", { message: "secret note", filename: "/private/path", lineno: 2, colno: 40 });
  f.fire("unhandledrejection", { reason: "private prompt" });
  expect(JSON.stringify(f.samples)).not.toMatch(/private|secret|prompt/);
  expect(f.samples.at(-2)).toEqual({ event: "error", id: 0, values: [2, 40] });
});

test("heartbeat distinguishes delayed JS, missing frames and graph draw errors", () => {
  const f = fixture();
  f.advance(4000); f.timers[0]!();
  expect(f.samples.at(-1).values.slice(0, 8)).toEqual([4000, 4000, 0, 0, 0, 0, -1, -1]);
  f.frames.shift()!();
  f.window.__BIGBRAIN_UI_DIAGNOSTICS__.render("end", 321);
  f.window.__BIGBRAIN_UI_DIAGNOSTICS__.render("error");
  expect(f.samples.at(-1).event).toBe("render_error");
  f.advance(1000); f.timers[0]!();
  expect(f.samples.at(-1).values.slice(3, 8)).toEqual([1, 1, 321, 1000, 1000]);
});

test("graph-off is explicit and hidden windows do not schedule frame probes", () => {
  const f = fixture("graph-off");
  expect(f.window.__BIGBRAIN_UI_DIAGNOSTICS__.graphOff).toBe(true);
  expect(fixture().window.__BIGBRAIN_UI_DIAGNOSTICS__.graphOff).toBe(false);
  f.document.hidden = true; f.advance(1000); f.timers[0]!();
  expect(f.frames.length).toBe(0);
  expect(f.samples.at(-1).values[8]).toBe(1);
  f.window.__BIGBRAIN_UI_DIAGNOSTICS__.probe(7);
  expect(f.samples.at(-1)).toEqual({ event: "native_probe", id: 7, values: [1000, 1] });
});

test("input storms cannot create unbounded outstanding native messages", () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) { f.advance(101); f.fire("keydown"); }
  expect(f.samples.length).toBe(32);
});
