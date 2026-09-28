import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRunUsage } from "../lib/meter";
import { BURST_MS, bursts, queryShape, shapeCounts, vocabularyGaps } from "../lib/econ";
import { labels, type RetrievalRecord } from "../lib/retrieval";

const at = (ms: number): Date => new Date(Date.parse("2026-08-12T17:17:00.000Z") + ms);

const search = (
  q: string,
  hits: string[],
  via: "api" | "cli" | "web",
  ms: number
): RetrievalRecord => ({ t: "search", at: at(ms).toISOString(), via, q, hits });
const use = (path: string, via: "api" | "cli" | "web", ms: number): RetrievalRecord => ({
  t: "use",
  at: at(ms).toISOString(),
  via,
  path,
});

describe("bursts", () => {
  test("the prod signature: zero-result reformulations, then a later spelling lands", () => {
    // The 2026-08-12 17:17 shape — three misses, then "semafor" is acted on.
    const ls = labels([
      search("DSA democratic socialists", [], "api", 0),
      search("Mamdani El-Sayed primary left", [], "api", 600),
      search("Semafor politics clip Nick note", [], "api", 1_200),
      search("semafor", ["entities/semafor.md"], "api", 7_800),
      use("entities/semafor.md", "api", 9_000),
    ]);
    const bs = bursts(ls);
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ via: "api", zeroResults: 3, recovered: true });
    expect(bs[0]!.queries).toHaveLength(4);
    expect(vocabularyGaps(bs)).toHaveLength(1);
  });

  test("a lone search is not a burst; a gap past the window splits the run", () => {
    const ls = labels([
      search("a", [], "api", 0),
      // next search past BURST_MS: two singletons, no burst
      search("b", ["x.md"], "api", BURST_MS + 1_000),
    ]);
    expect(bursts(ls)).toHaveLength(0);
  });

  test("doors never share a burst", () => {
    // Distinct spellings on purpose: a shared prefix would be collapsed as
    // typeahead by labels() before bursts ever sees it.
    const ls = labels([
      search("alpha", [], "api", 0),
      search("alpha", [], "web", 500),
      search("beta", ["x.md"], "api", 1_000),
      search("beta", ["x.md"], "web", 1_500),
    ]);
    const bs = bursts(ls);
    expect(bs).toHaveLength(2);
    expect(bs.map((b) => b.via).sort()).toEqual(["api", "web"]);
  });

  test("recovery must FOLLOW the zero-result — a hit before the miss is not a gap", () => {
    const ls = labels([
      search("good", ["x.md"], "api", 0),
      use("x.md", "api", 500),
      search("bad", [], "api", 5_000),
    ]);
    const bs = bursts(ls);
    expect(bs).toHaveLength(1);
    expect(bs[0]!.recovered).toBe(false);
    expect(vocabularyGaps(bs)).toHaveLength(0);
  });
});

describe("query shapes", () => {
  test("time beats entity; entity reads from what answered; unknown when nothing shown", () => {
    const ls = labels([
      search("what happened in march 2026", ["entities/a.md"], "api", 0),
      search("dana", ["entities/dana-reed.md", "references/x.md"], "api", 60_000),
      use("entities/dana-reed.md", "api", 61_000),
      search("gpu kernels", ["references/y.md"], "api", 200_000),
      search("nothing", [], "api", 300_000),
    ]);
    expect(ls.map(queryShape)).toEqual(["time", "entity", "other", "unknown"]);
    expect(shapeCounts(ls)).toEqual({ time: 1, entity: 1, other: 1, unknown: 1 });
  });

  test("a month is time only next to a digit — ordinary English is not", () => {
    const shape = (q: string, hits: string[]): string =>
      queryShape(labels([search(q, hits, "api", 0)])[0]!);
    expect(shape("it may help", ["entities/a.md"])).toBe("entity");
    expect(shape("august wilson plays", ["references/x.md"])).toBe("other");
    expect(shape("may 2026 budget", ["references/x.md"])).toBe("time");
    expect(shape("12 march meeting", ["references/x.md"])).toBe("time");
    expect(shape("last week", [])).toBe("time");
  });
});

describe("collectRunUsage `at`", () => {
  test("a journal's startedAt lands on its PerRun row; a legacy journal reads as ''", () => {
    const root = mkdtempSync(join(tmpdir(), "econ-"));
    const dir = join(root, "journal", "queue");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run-new.json"),
      JSON.stringify({
        startedAt: "2026-08-12T01:00:00.000Z",
        model: "m",
        engine: "pi",
        usage: { cost_usd: 0.5, input_tokens: 10, output_tokens: 5, turns: 1 },
      })
    );
    writeFileSync(
      join(dir, "run-old.json"),
      JSON.stringify({ model: "m", engine: "pi", usage: { cost_usd: 0.25 } })
    );
    const per = collectRunUsage(root);
    const rows = Object.fromEntries(per.map((r) => [r.run_id, r.at]));
    expect(rows).toEqual({ "run-new": "2026-08-12T01:00:00.000Z", "run-old": "" });
    expect(per.reduce((n, r) => n + r.cost_usd, 0)).toBeCloseTo(0.75);
  });
});
