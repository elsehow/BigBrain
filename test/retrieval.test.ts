import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collapseTypeahead,
  contentUseRel,
  heat,
  isLedgerPath,
  labels,
  ledgerRel,
  readLedger,
  recordSearch,
  recordUse,
  summary,
  TYPEAHEAD_MS,
  USE_WINDOW_MS,
  type RetrievalRecord,
  type SearchRecord,
} from "../lib/retrieval";

const tmp = (): string => mkdtempSync(join(tmpdir(), "retrieval-"));
const at = (ms: number): Date => new Date(Date.parse("2026-08-11T12:00:00.000Z") + ms);

const search = (
  q: string,
  hits: string[],
  via: "api" | "cli" | "web",
  ms: number,
  tiers?: (0 | 1 | 2)[]
): RetrievalRecord => ({
  t: "search",
  at: at(ms).toISOString(),
  via,
  q,
  hits,
  ...(tiers ? { tiers } : {}),
});
const use = (path: string, via: "api" | "cli" | "web", ms: number): RetrievalRecord => ({
  t: "use",
  at: at(ms).toISOString(),
  via,
  path,
});

describe("the ledger on disk", () => {
  test("a search and a use round-trip through the monthly file", () => {
    const root = tmp();
    recordSearch(root, "rich sutton", [{ path: "entities/rich-sutton.md" }], "api", at(0));
    recordUse(root, "entities/rich-sutton.md", "api", at(1_000));

    expect(existsSync(join(root, ledgerRel(at(0))))).toBe(true);
    expect(ledgerRel(at(0))).toBe("journal/retrieval/2026-08.jsonl");

    const recs = readLedger(root);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual({
      t: "search",
      at: at(0).toISOString(),
      via: "api",
      q: "rich sutton",
      hits: ["entities/rich-sutton.md"],
    });
    expect(recs[1]).toMatchObject({ t: "use", path: "entities/rich-sutton.md" });
  });

  test("the watcher's guard recognizes ledger writes and nothing else", () => {
    // What the ledger itself writes must be recognized, or the viewer's own
    // /api/note appends echo back to every open tab as change pings.
    expect(isLedgerPath(ledgerRel(at(0)))).toBe(true);
    expect(isLedgerPath("journal\\retrieval\\2026-08.jsonl")).toBe(true);
    // The rest of journal/ (and the vault) still pings.
    expect(isLedgerPath("journal/runs/2026-08-12.jsonl")).toBe(false);
    expect(isLedgerPath("journal")).toBe(false);
    expect(isLedgerPath("references/retrieval.md")).toBe(false);
    expect(isLedgerPath("")).toBe(false);
  });

  test("plain string hits work as well as SearchHit objects", () => {
    const root = tmp();
    recordSearch(root, "q", ["a.md", "b.md"], "web", at(0));
    expect((readLedger(root)[0] as { hits: string[] }).hits).toEqual(["a.md", "b.md"]);
  });

  test("an empty query writes nothing at all", () => {
    const root = tmp();
    recordSearch(root, "   ", [{ path: "a.md" }], "web", at(0));
    recordUse(root, "", "web", at(0));
    expect(readLedger(root)).toEqual([]);
    expect(existsSync(join(root, "journal", "retrieval"))).toBe(false);
  });

  test("one call cannot bloat the ledger: query and hit list are clipped", () => {
    const root = tmp();
    const hits = Array.from({ length: 60 }, (_, i) => `n${i}.md`);
    recordSearch(root, "x".repeat(5_000), hits, "web", at(0));
    const rec = readLedger(root)[0] as { q: string; hits: string[] };
    expect(rec.q.length).toBe(512);
    expect(rec.hits).toHaveLength(20);
    expect(rec.hits[0]).toBe("n0.md");
  });

  test("a torn line loses itself, never the month", () => {
    const root = tmp();
    recordSearch(root, "one", ["a.md"], "web", at(0));
    const abs = join(root, ledgerRel(at(0)));
    Bun.write(abs, `${readFileSync(abs, "utf8")}{"t":"search","at":\n`);
    recordSearch(root, "two", ["b.md"], "web", at(1_000));
    const recs = readLedger(root);
    expect(recs.map((r) => (r.t === "search" ? r.q : r.path))).toEqual(["one", "two"]);
  });

  test("a lost label never costs the caller: an unwritable root does not throw", () => {
    expect(() => recordSearch("/proc/nonexistent/nope", "q", ["a.md"], "api", at(0))).not.toThrow();
    expect(() => recordUse("/proc/nonexistent/nope", "a.md", "api", at(0))).not.toThrow();
  });

  test("the opt-out silences the ledger", () => {
    const root = tmp();
    process.env["BIGBRAIN_NO_RETRIEVAL_LOG"] = "1";
    try {
      recordSearch(root, "q", ["a.md"], "web", at(0));
    } finally {
      delete process.env["BIGBRAIN_NO_RETRIEVAL_LOG"];
    }
    expect(readLedger(root)).toEqual([]);
  });

  test("readLedger on a vault that has never searched is empty, not an error", () => {
    expect(readLedger(tmp())).toEqual([]);
  });
});

describe("joining a use back to the search that caused it", () => {
  test("the click on a hit becomes a label, with its rank", () => {
    const ls = labels([
      search("sutton", ["entities/a.md", "entities/rich-sutton.md"], "web", 0),
      use("entities/rich-sutton.md", "web", 4_000),
    ]);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({
      q: "sutton",
      used: ["entities/rich-sutton.md"],
      firstUsedRank: 2,
    });
  });

  test("a search nobody acts on is the negative example, kept", () => {
    const ls = labels([search("sutton", ["entities/a.md"], "web", 0)]);
    expect(ls[0]).toMatchObject({ used: [], firstUsedRank: 0 });
  });

  test("a read of something the search never showed attributes to nothing", () => {
    const ls = labels([
      search("sutton", ["entities/a.md"], "web", 0),
      use("entities/zz.md", "web", 1_000),
    ]);
    expect(ls[0]!.used).toEqual([]);
  });

  test("the MOST RECENT matching search wins", () => {
    const ls = labels([
      search("first", ["entities/a.md"], "api", 0),
      search("second", ["entities/a.md"], "api", 60_000),
      use("entities/a.md", "api", 61_000),
    ]);
    expect(ls.find((l) => l.q === "first")!.used).toEqual([]);
    expect(ls.find((l) => l.q === "second")!.used).toEqual(["entities/a.md"]);
  });

  test("surfaces never cross — a UI click is not an agent's fetch", () => {
    const ls = labels([
      search("q", ["entities/a.md"], "web", 0),
      use("entities/a.md", "api", 1_000),
    ]);
    expect(ls[0]!.used).toEqual([]);
  });

  test("a read long after the search is not caused by it", () => {
    const ls = labels([
      search("q", ["entities/a.md"], "api", 0),
      use("entities/a.md", "api", USE_WINDOW_MS + 1),
    ]);
    expect(ls[0]!.used).toEqual([]);
  });

  test("re-reading the same note does not count twice", () => {
    const ls = labels([
      search("q", ["entities/a.md", "entities/b.md"], "api", 0),
      use("entities/a.md", "api", 1_000),
      use("entities/a.md", "api", 2_000),
      use("entities/b.md", "api", 3_000),
    ]);
    expect(ls[0]!.used).toEqual(["entities/a.md", "entities/b.md"]);
    expect(ls[0]!.firstUsedRank).toBe(1);
  });

  test("records out of order still join correctly", () => {
    const ls = labels([
      use("entities/a.md", "api", 1_000),
      search("q", ["entities/a.md"], "api", 0),
    ]);
    expect(ls[0]!.used).toEqual(["entities/a.md"]);
  });
});

describe("typeahead is typing, not asking", () => {
  test("prefixes superseded moments later are dropped", () => {
    const recs = [
      search("ric", ["entities/a.md"], "web", 0),
      search("rich sut", ["entities/a.md"], "web", 300),
      search("rich sutton", ["entities/rich-sutton.md"], "web", 900),
    ];
    const kept = collapseTypeahead(recs).filter((r) => r.t === "search");
    expect(kept).toHaveLength(1);
    expect((kept[0] as { q: string }).q).toBe("rich sutton");
  });

  test("the same prefix typed again much later is its own question", () => {
    const recs = [
      search("ric", ["a.md"], "web", 0),
      search("rich sutton", ["a.md"], "web", TYPEAHEAD_MS + 1),
    ];
    expect(collapseTypeahead(recs)).toHaveLength(2);
  });

  test("an unrelated query is never a prefix", () => {
    const recs = [search("sutton", ["a.md"], "web", 0), search("hoffman", ["b.md"], "web", 200)];
    expect(collapseTypeahead(recs)).toHaveLength(2);
  });

  test("collapsing keeps the use attributed to the query the person meant", () => {
    const ls = labels([
      search("ric", ["entities/a.md"], "web", 0),
      search("rich sutton", ["entities/rich-sutton.md"], "web", 400),
      use("entities/rich-sutton.md", "web", 3_000),
    ]);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ q: "rich sutton", used: ["entities/rich-sutton.md"] });
  });

  test("uses are never dropped by the collapse", () => {
    const recs = [
      search("a", ["x.md"], "web", 0),
      search("ab", ["x.md"], "web", 100),
      use("x.md", "web", 200),
    ];
    expect(collapseTypeahead(recs).filter((r) => r.t === "use")).toHaveLength(1);
  });
});

describe("summary", () => {
  test("cli searches count as searches but never score — their use is unobservable", () => {
    const s = summary(
      labels([
        search("a", ["x.md"], "cli", 0),
        search("b", ["x.md", "y.md"], "web", 60_000),
        use("y.md", "web", 61_000),
      ])
    );
    expect(s.searches).toBe(2);
    expect(s.withUse).toBe(1);
    expect(s.hitRate).toBe(1); // one scorable search, and it was used
    expect(s.mrr).toBe(0.5); // the used hit was rank 2
  });

  test("a search that showed nothing is counted as such", () => {
    const s = summary(labels([search("nothing here", [], "web", 0)]));
    expect(s.zeroResult).toBe(1);
    expect(s.hitRate).toBe(0);
  });

  test("no searches is zero, not NaN", () => {
    expect(summary([])).toEqual({
      searches: 0,
      withUse: 0,
      hitRate: 0,
      mrr: 0,
      zeroResult: 0,
      answeredByList: 0,
      seenRecently: 0,
      misses: 0,
      relaxed: 0,
    });
  });
});

describe("heat", () => {
  test("counts every use — including ones labels() would drop as unattributed", () => {
    const recs: RetrievalRecord[] = [
      // no search anywhere: a wikilink-follow, invisible to labels()
      use("entities/alex-rowan.md", "web", 0),
      use("entities/alex-rowan.md", "api", 1_000),
      use("domains/product/pricing.md", "web", 2_000),
    ];
    expect(labels(recs)).toHaveLength(0);
    const h = heat(recs);
    expect(h.notes).toEqual([
      { path: "entities/alex-rowan.md", reads: 2, lastAt: at(1_000).toISOString() },
      { path: "domains/product/pricing.md", reads: 1, lastAt: at(2_000).toISOString() },
    ]);
  });

  test("searches are not demand — only uses count", () => {
    const h = heat([search("pricing", ["domains/product/pricing.md"], "web", 0)]);
    expect(h.notes).toHaveLength(0);
    expect(h.trees).toHaveLength(0);
  });

  test("the window drops reads before `since` and keeps the boundary", () => {
    const recs: RetrievalRecord[] = [
      use("old.md", "web", 0),
      use("edge.md", "web", 60_000),
      use("new.md", "web", 120_000),
    ];
    const h = heat(recs, at(60_000));
    expect(h.since).toBe(at(60_000).toISOString());
    expect(h.notes.map((n) => n.path).sort()).toEqual(["edge.md", "new.md"]);
  });

  test("trees roll up by first segment; a root file lands under '.'", () => {
    const h = heat([
      use("entities/a.md", "web", 0),
      use("entities/b.md", "web", 1_000),
      use("entities/b.md", "web", 2_000),
      use("INDEX.md", "web", 3_000),
    ]);
    expect(h.trees).toEqual([
      { tree: "entities", reads: 3 },
      { tree: ".", reads: 1 },
    ]);
  });

  test("ties order deterministically by path", () => {
    const h = heat([use("b.md", "web", 0), use("a.md", "web", 1_000)]);
    expect(h.notes.map((n) => n.path)).toEqual(["a.md", "b.md"]);
  });

  test("a torn line — pathless use, garbage `at` — loses itself, never the readout", () => {
    const pathless = { t: "use", at: at(0).toISOString(), via: "web" } as RetrievalRecord;
    const garbageAt: RetrievalRecord = { t: "use", at: "zzz-not-a-date", via: "web", path: "x.md" };
    // garbage `at` sorts lexically above any ISO date: unguarded it would
    // slip into every window and win lastAt.
    const h = heat([pathless, garbageAt, use("a.md", "web", 1_000)], at(500));
    expect(h.notes).toEqual([{ path: "a.md", reads: 1, lastAt: at(1_000).toISOString() }]);
  });

  test("the journal tree — ledger, pass journals, verdicts — is not demand", () => {
    const h = heat([
      use("journal/retrieval/2026-08.jsonl", "api", 0),
      use("journal/passes/2026-08-12-deep.md", "api", 500),
      use("journal/verdicts/link.jsonl", "api", 700),
      use("entities/a.md", "web", 1_000),
    ]);
    expect(h.notes.map((n) => n.path)).toEqual(["entities/a.md"]);
    expect(h.trees).toEqual([{ tree: "entities", reads: 1 }]);
  });

  test("an Invalid Date `since` reads as no window, not a crash", () => {
    const h = heat([use("a.md", "web", 0)], new Date(Number.NaN));
    expect(h.since).toBeNull();
    expect(h.notes).toHaveLength(1);
  });
});

describe("#359: the read hook and the outcome column", () => {
  test("tiers round-trip through the monthly file; plain paths stay tierless", () => {
    const root = tmp();
    recordSearch(root, "karolis", [{ path: "entities/karolis.md", tier: 0 }], "api", at(0));
    recordSearch(root, "plain", ["entities/a.md"], "api", at(1_000));
    const [tiered, plain] = readLedger(root) as SearchRecord[];
    expect(tiered!.tiers).toEqual([0]);
    expect(plain!.tiers).toBeUndefined();
  });

  test("a cli read joins the api search that showed it — one agent, two doors", () => {
    const ls = labels([
      search("sutton", ["entities/rich-sutton.md"], "api", 0),
      use("entities/rich-sutton.md", "cli", 4_000),
    ]);
    expect(ls[0]).toMatchObject({
      used: ["entities/rich-sutton.md"],
      firstUsedRank: 1,
      outcome: "acted",
    });
  });

  test("web stays its own surface: a cli read never joins a web search", () => {
    const ls = labels([
      search("sutton", ["entities/a.md"], "web", 0),
      use("entities/a.md", "cli", 1_000),
    ]);
    expect(ls[0]!.used).toEqual([]);
  });

  test("a name check nobody opened is answered by the list, not missed", () => {
    const ls = labels([search("karolis", ["entities/karolis.md"], "api", 0, [0])]);
    expect(ls[0]!.outcome).toBe("answeredByList");
  });

  test("a search whose hit was read moments before was already in hand", () => {
    const ls = labels([
      use("entities/a.md", "api", 0),
      search("that note again", ["entities/a.md"], "api", 5_000, [2]),
    ]);
    expect(ls.find((l) => l.q === "that note again")!.outcome).toBe("seenRecently");
  });

  test("a body-match search nobody acts on is the honest miss", () => {
    const ls = labels([search("vague vocabulary", ["entities/a.md"], "api", 0, [2])]);
    expect(ls[0]!.outcome).toBe("miss");
  });

  test("a tierless record can still be a miss — outcomes degrade, never lie", () => {
    const ls = labels([search("old record", ["entities/a.md"], "api", 0)]);
    expect(ls[0]!.topTier).toBeNull();
    expect(ls[0]!.outcome).toBe("miss");
  });

  test("an acted search outranks every other outcome", () => {
    const ls = labels([
      use("entities/a.md", "api", 0),
      search("karolis", ["entities/a.md"], "api", 1_000, [0]),
      use("entities/a.md", "api", 2_000),
    ]);
    expect(ls[0]!.outcome).toBe("acted");
  });

  test("summary buckets the non-demand outcomes out of the honest miss set", () => {
    const s = summary(
      labels([
        search("acted", ["entities/a.md"], "api", 0, [2]),
        use("entities/a.md", "api", 1_000),
        search("karolis", ["entities/karolis.md"], "api", 60_000, [0]),
        search("vague", ["entities/b.md"], "api", 120_000, [2]),
      ])
    );
    expect(s.withUse).toBe(1);
    expect(s.answeredByList).toBe(1);
    expect(s.seenRecently).toBe(0);
    expect(s.misses).toBe(1);
  });
});

describe("contentUseRel: the read hook's filter", () => {
  const root = "/vaults/demo";
  test("content notes map to their vault-relative form, absolute or relative", () => {
    expect(contentUseRel(root, "/vaults/demo/references/2026-08-14-a-note.md")).toBe(
      "references/2026-08-14-a-note.md"
    );
    expect(contentUseRel(root, "entities/karolis.md")).toBe("entities/karolis.md");
  });

  test("everything else answers null: memory, the journal, code, the outside", () => {
    expect(contentUseRel(root, "/vaults/demo/memory/MEMORY.md")).toBeNull();
    expect(contentUseRel(root, "journal/retrieval/2026-08.jsonl")).toBeNull();
    expect(contentUseRel(root, "/vaults/demo/references/raw.pdf")).toBeNull();
    expect(contentUseRel(root, "/somewhere/else/references/a.md")).toBeNull();
    expect(contentUseRel(root, "")).toBeNull();
  });

  test("the native trees land too (#502): projection entity pages and log source paths", () => {
    expect(contentUseRel(root, "projection/entities/ent_0123456789abcdef0123.md")).toBe(
      "projection/entities/ent_0123456789abcdef0123.md"
    );
    expect(contentUseRel(root, "/vaults/demo/log/insertions/2026-08/ins_x.md")).toBe(
      "log/insertions/2026-08/ins_x.md"
    );
    expect(contentUseRel(root, "projection/graph.json")).toBeNull(); // still .md-only
  });
});

describe("#361: relaxation on the ledger", () => {
  test("the rung rides the record and its label; absent means exact", () => {
    const root = tmp();
    recordSearch(root, "dsa socialists", ["references/primary.md"], "api", at(0), "any-term");
    recordSearch(root, "socialist", ["references/primary.md"], "api", at(1_000));
    const [relaxed, exact] = readLedger(root) as SearchRecord[];
    expect(relaxed!.relaxation).toBe("any-term");
    expect(exact!.relaxation).toBeUndefined();
    const ls = labels(readLedger(root));
    expect(ls.find((l) => l.q === "dsa socialists")!.relaxation).toBe("any-term");
    expect(ls.find((l) => l.q === "socialist")!.relaxation).toBeNull();
  });

  test("summary counts the rescued zero-hits", () => {
    const s = summary(
      labels([
        { ...search("dsa socialists", ["references/primary.md"], "api", 0), relaxation: "any-term" } as RetrievalRecord,
        search("socialist", ["references/primary.md"], "api", 60_000),
      ])
    );
    expect(s.relaxed).toBe(1);
    expect(s.zeroResult).toBe(0);
  });
});
