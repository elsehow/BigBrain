import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  commandKey,
  composeCapture,
  createSearchRunner,
  isIngestShortcut,
  shouldOfferIngest,
  topHitPath,
} from "../web/ui/src/lib/omnibox";

// On macOS, Ctrl-K deletes to the end of the line in a text field.
// Only Command-K should focus global search; keep the modifiers distinct.
describe("commandKey — ⌘ on a Mac, Ctrl elsewhere, never both", () => {
  const cmd = { metaKey: true, ctrlKey: false };
  const ctrl = { metaKey: false, ctrlKey: true };
  const none = { metaKey: false, ctrlKey: false };
  test("on a Mac ⌘ is the command key and Ctrl is the text field's own", () => {
    expect(commandKey(cmd, true)).toBe(true);
    expect(commandKey(ctrl, true)).toBe(false);
    expect(commandKey(none, true)).toBe(false);
  });
  test("elsewhere Ctrl is the command key", () => {
    expect(commandKey(ctrl, false)).toBe(true);
    expect(commandKey(cmd, false)).toBe(false);
    expect(commandKey(none, false)).toBe(false);
  });
  test("both held is neither — ⌘⌃K is not the search key", () => {
    expect(commandKey({ metaKey: true, ctrlKey: true }, true)).toBe(false);
    expect(commandKey({ metaKey: true, ctrlKey: true }, false)).toBe(false);
  });
});

describe("isIngestShortcut", () => {
  test("Cmd+Enter is the shortcut", () => {
    expect(isIngestShortcut({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
  });
  test("Ctrl+Enter is the shortcut too (non-Mac)", () => {
    expect(isIngestShortcut({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
  });
  test("plain Enter is NOT the ingest shortcut — it opens the selection instead", () => {
    expect(isIngestShortcut({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
  });
  test("Cmd held on a different key is not the shortcut", () => {
    expect(isIngestShortcut({ key: "k", metaKey: true, ctrlKey: false })).toBe(false);
  });
});

describe("topHitPath", () => {
  test("the strongest (first) hit's path", () => {
    expect(topHitPath([{ note: { path: "a.md" } }, { note: { path: "b.md" } }])).toBe("a.md");
  });
  test("no hits → null, so Enter can no-op", () => {
    expect(topHitPath([])).toBeNull();
  });
});

describe("shouldOfferIngest", () => {
  test("offers once a real query has settled with zero hits", () => {
    expect(shouldOfferIngest("gravity waves", "gravity waves", false)).toBe(true);
  });
  test("offers when there ARE hits too — the mockup's CAPTURE band sits under a result list", () => {
    expect(shouldOfferIngest("gravity waves", "gravity waves", false)).toBe(true);
  });
  test("does not offer while a search is still in flight", () => {
    expect(shouldOfferIngest("gravity waves", "gravity waves", true)).toBe(false);
  });
  test("does not offer for an empty query", () => {
    expect(shouldOfferIngest("   ", "", false)).toBe(false);
  });
  test("does not offer for a DIFFERENT, still-loading query", () => {
    // the input has moved on to a new query but the hit list is still the
    // previous one — capture must name query B only once B's own search has
    // landed, never while A's results are on screen.
    expect(shouldOfferIngest("query b", "query a", false)).toBe(false);
  });
});

describe("composeCapture", () => {
  test("wraps the raw text in frontmatter with a pinned date, body verbatim below", () => {
    const now = new Date("2026-08-02T00:00:00Z");
    const { filename, content } = composeCapture("Call the plumber about the leak\nurgent", {
      now,
    });
    expect(filename).toBe("call-the-plumber-about-the-leak.md");
    expect(content).toContain('kind: "capture"');
    expect(content).toContain('title: "Call the plumber about the leak"');
    expect(content).toContain('date: "2026-08-02"');
    expect(content.trim().endsWith("Call the plumber about the leak\nurgent")).toBe(true);
  });

  // The lake's exact-dupe identity is the sha256 of the payload as sent
  // (lib/intake.ts) — a client-minted id would put a fresh timestamp in
  // every payload and dedup would never fire (issue #251). No `id`, no
  // `source` field either: the server stamps both.
  test("mints no id and no source — the server stamps both from the verified credential", () => {
    const { content } = composeCapture("a quick thought", { now: new Date("2026-08-02") });
    expect(content).not.toMatch(/^id:/m);
    expect(content).not.toMatch(/^source:/m);
  });

  test("two identical captures produce byte-identical payloads — the dedup identity", () => {
    const now = new Date("2026-08-02T00:00:00Z");
    const a = composeCapture("Call the plumber about the leak\nurgent", { now });
    const b = composeCapture("Call the plumber about the leak\nurgent", { now });
    expect(a.content).toBe(b.content);
    expect(a.filename).toBe(b.filename);
  });

  test("send as-is: a URL is not fetched or specially parsed, just carried as the body", () => {
    const { content } = composeCapture("https://example.com/some/article", {
      now: new Date("2026-08-02"),
    });
    expect(content).toContain("https://example.com/some/article");
    expect(content).toContain('title: "https://example.com/some/article"');
  });

  test("falls back to a generic slug/title for content with no usable first line", () => {
    const { filename, content } = composeCapture("   \n\nbody only", {
      now: new Date("2026-08-02"),
    });
    expect(filename).toBe("body-only.md");
    expect(content).toContain('title: "body only"');
  });

  test("without a pinned now, still produces a well-formed item (default exercised)", () => {
    const { filename, content } = composeCapture("a quick thought");
    expect(filename).toBe("a-quick-thought.md");
    expect(content).toMatch(/date: "\d{4}-\d{2}-\d{2}"/);
  });
});

describe("createSearchRunner (#456)", () => {
  // Fake time, a millisecond at a time with the promise queue drained between
  // steps: the runner's order of events, not the machine's speed. On real
  // timers a busy CI runner let a 30ms wait elapse before a 1ms debounce and
  // a 5ms reply had both fired.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const tick = async (ms: number) => {
    for (let i = 0; i < ms; i++) {
      jest.advanceTimersByTime(1);
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    }
  };

  test("rapid keystrokes execute one search, not one per keystroke", async () => {
    const calls: string[] = [];
    const run = createSearchRunner<string>({
      search: async (q) => {
        calls.push(q);
        return { hits: [q] };
      },
      settle: () => {},
      pending: () => {},
      cleared: () => {},
      debounceMs: 10,
    });
    run("b");
    run("br");
    run("briar");
    await tick(40);
    expect(calls).toEqual(["briar"]);
  });

  test("a later query aborts the request already on the wire; only the latest settles", async () => {
    const outcomes: string[] = [];
    const aborted: string[] = [];
    const run = createSearchRunner<string>({
      search: (q, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted.push(q);
            reject(new Error("aborted"));
          });
          if (q === "final") setTimeout(() => resolve({ hits: [q] }), 5);
          // any other query hangs until aborted — the pathological slow server
        }),
      settle: (outcome) => outcomes.push(`${outcome.query}:${outcome.failed || "ok"}`),
      pending: () => {},
      cleared: () => {},
      debounceMs: 1,
    });
    run("slow");
    await tick(10); // "slow" is on the wire, hanging
    run("final");
    await tick(30);
    expect(aborted).toEqual(["slow"]);
    expect(outcomes).toEqual(["final:ok"]); // the superseded query settles NOTHING
  });

  test("the deadline settles a hung search into the bounded slow posture", async () => {
    const outcomes: { query: string; hits: string[]; failed: string }[] = [];
    const run = createSearchRunner<string>({
      search: (_q, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      settle: (outcome) => outcomes.push(outcome),
      pending: () => {},
      cleared: () => {},
      debounceMs: 1,
      timeoutMs: 15,
    });
    run("briar");
    await tick(50);
    expect(outcomes).toEqual([{ query: "briar", hits: [], failed: "slow" }]);
  });

  test("a refusal settles into the error posture; an emptied box aborts and clears", async () => {
    const outcomes: string[] = [];
    let cleared = 0;
    let sawAbort = 0;
    const run = createSearchRunner<string>({
      search: (q, signal) => {
        if (q === "refused") return Promise.reject(new Error("500"));
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort += 1;
            reject(new Error("aborted"));
          });
        });
      },
      settle: (outcome) => outcomes.push(`${outcome.query}:${outcome.failed}`),
      pending: () => {},
      cleared: () => {
        cleared += 1;
      },
      debounceMs: 1,
      timeoutMs: 1000,
    });
    run("refused");
    await tick(10);
    expect(outcomes).toEqual(["refused:error"]);
    run("hanging");
    await tick(10);
    run(""); // the box emptied — the wire request must not outlive it
    await tick(10);
    expect(sawAbort).toBe(1);
    expect(cleared).toBe(1);
    expect(outcomes).toEqual(["refused:error"]);
  });
});

describe("interactive search reuse", () => {
  const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  test("completed queries return synchronously; revision keys and expiration force fresh scans", async () => {
    const calls: string[] = [];
    const settled: string[] = [];
    const run = createSearchRunner<string>({
      search: async q => { calls.push(q); return { hits: [q] }; },
      settle: r => settled.push(r.hits[0] ?? ""), pending: () => {}, cleared: () => {},
      debounceMs: 1, cacheMs: 80,
    });
    run("revision-1:maya"); await tick(15);
    run(""); run("revision-1:maya");
    expect(settled).toEqual(["revision-1:maya", "revision-1:maya"]);
    expect(calls).toHaveLength(1);
    run("revision-2:maya"); await tick(15);
    expect(calls).toHaveLength(2);
    await tick(85); run("revision-2:maya"); await tick(15);
    expect(calls).toHaveLength(3);
  });
  test("returning to a cached query cancels stale work and a stale reply cannot replace it", async () => {
    let finishSlow: ((r: { hits: string[] }) => void) | undefined;
    let firstSettled!: () => void, slowStarted!: () => void;
    const firstReady = new Promise<void>(resolve => { firstSettled = resolve; });
    const slowReady = new Promise<void>(resolve => { slowStarted = resolve; });
    let aborted = false;
    const settled: string[] = [];
    const run = createSearchRunner<string>({
      search: async (q, signal) => {
        if (q !== "slow") return { hits: [q] };
        signal.addEventListener("abort", () => { aborted = true; });
        return new Promise(resolve => { finishSlow = resolve; slowStarted(); });
      },
      settle: r => { settled.push(r.hits[0] ?? ""); firstSettled(); }, pending: () => {}, cleared: () => {},
      // Exercise cancellation independently of runner pauses. Expiry has its
      // own test above; this cached query must remain available throughout.
      debounceMs: 0, cacheMs: Infinity,
    });
    run("maya"); await firstReady;
    run("slow"); await slowReady;
    run("maya");
    expect(aborted).toBe(true);
    expect(settled).toEqual(["maya", "maya"]);
    finishSlow!({ hits: ["slow"] }); await tick(5);
    expect(settled).toEqual(["maya", "maya"]);
  });
  test("failed searches remain retryable and only 32 completed queries are retained", async () => {
    const calls: string[] = [];
    const run = createSearchRunner<string>({
      search: async q => { calls.push(q); if (q === "fail") throw Error("failed"); return { hits: [q] }; },
      settle: () => {}, pending: () => {}, cleared: () => {}, debounceMs: 0, cacheMs: 1000,
    });
    run("fail"); await tick(5); run("fail"); await tick(5);
    expect(calls).toEqual(["fail", "fail"]);
    for (let i = 0; i < 33; i++) { run(`q${i}`); await tick(3); }
    run("q32"); expect(calls.at(-1)).toBe("q32");
    const count = calls.length;
    run("q0"); await tick(5);
    expect(calls.length).toBe(count + 1);
  });
});
