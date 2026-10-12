import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Graph } from "../lib/graph";
import { assertionGraphCached, graphWithLayout, readLayoutCache } from "../lib/graphCache";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { appendAndProjectAssertion, appendAndProjectDecline, openAssertionProjectionReadonly, projectSourceInsertion } from "../lib/assertionProjection";
import { assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { createDeclineEvent } from "../lib/declineLog";
import { recentFromSourceLog } from "../lib/sourceFeed";
import { insertion } from "./support/vault";

// The graph routes' state: the settled-layout cache (PRODUCED here rather
// than uploaded by a browser — see lib/graphLayout.ts) and the short build
// memo.

const fresh = (): string => mkdtempSync(join(tmpdir(), "bb-graph-"));

const graph = (hash: string, ids: string[], edges: [string, string][] = []): Graph => ({
  nodes: ids.map((id) => ({ id, title: id, group: "entity", degree: 1 })),
  edges: edges.map(([source, target]) => ({ source, target })),
  hash,
});

describe("layout cache", () => {
  test("no cache file yet reads as null, never a throw", () => {
    expect(readLayoutCache(fresh())).toBeNull();
  });

  test("a first read settles the layout, bakes it onto the nodes, and persists it", () => {
    const root = fresh();
    const g = graphWithLayout(root, graph("h1", ["entities/a.md", "entities/b.md"], [["entities/a.md", "entities/b.md"]]));

    for (const n of g.nodes) {
      expect(typeof n.x).toBe("number");
      expect(Number.isFinite(n.x)).toBe(true);
    }
    const stored = readLayoutCache(root);
    expect(stored?.hash).toBe("h1");
    expect(Object.keys(stored!.positions).sort()).toEqual(["entities/a.md", "entities/b.md"]);
  });

  test("the second read of the same structure reuses the stored positions exactly", () => {
    const root = fresh();
    const first = graphWithLayout(root, graph("h1", ["entities/a.md", "entities/b.md"]));
    const firstPos = first.nodes.map((n) => [n.x, n.y]);
    // A fresh graph object for the same hash — as a later request would build.
    const second = graphWithLayout(root, graph("h1", ["entities/a.md", "entities/b.md"]));
    expect(second.nodes.map((n) => [n.x, n.y])).toEqual(firstPos);
  });

  test("a structure change re-settles and OVERWRITES — the cache never accumulates", () => {
    const root = fresh();
    graphWithLayout(root, graph("h1", ["entities/a.md", "entities/b.md"]));
    graphWithLayout(root, graph("h2", ["entities/a.md", "entities/b.md", "entities/c.md"]));
    const stored = readLayoutCache(root);
    expect(stored?.hash).toBe("h2"); // one entry, not two
    expect(Object.keys(stored!.positions)).toHaveLength(3);
  });

  test("a survivor keeps roughly its place across a structure change", () => {
    // Continuity is the point of seeding from the superseded layout: a new
    // node must not re-throw the whole graph. Without the seed, `a` lands
    // wherever a cold phyllotaxis start puts it — hundreds of units away.
    const root = fresh();
    const before = graphWithLayout(root, graph("h1", ["a.md", "b.md", "c.md", "d.md"], [["a.md", "b.md"], ["c.md", "d.md"]]));
    const was = before.nodes.find((n) => n.id === "a.md")!;
    const after = graphWithLayout(root, graph("h2", ["a.md", "b.md", "c.md", "d.md", "e.md"], [["a.md", "b.md"], ["c.md", "d.md"], ["d.md", "e.md"]]));
    const now = after.nodes.find((n) => n.id === "a.md")!;
    expect(Math.hypot(now.x! - was.x!, now.y! - was.y!)).toBeLessThan(120);
  });

  test("a small change is placed; once placements add up to a tenth of the graph, it settles whole", () => {
    const root = fresh();
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}.md`);
    const chain = ids.slice(1).map((id, i) => [ids[i]!, id] as [string, string]);
    graphWithLayout(root, graph("h0", ids, chain));
    const settled = readLayoutCache(root)!;
    expect(settled.moved).toBe(0);
    // one new node on the end: it and n39 move, the rest stand still
    graphWithLayout(root, graph("h1", [...ids, "x0.md"], [...chain, ["n39.md", "x0.md"]]));
    const placed = readLayoutCache(root)!;
    expect(placed.moved).toBe(2);
    expect(placed.positions["n0.md"]).toEqual(settled.positions["n0.md"]!);
    // more of them: past 10% of the graph, a whole settle, and the count starts over
    graphWithLayout(root, graph("h2", [...ids, "x0.md", "x1.md", "x2.md"], [...chain, ["n39.md", "x0.md"], ["x0.md", "x1.md"], ["x1.md", "x2.md"]]));
    expect(readLayoutCache(root)!.moved).toBe(0);
  });

  test("a layout saved before placement settles whole once, then places", () => {
    const root = fresh();
    graphWithLayout(root, graph("h1", ["a.md", "b.md"], [["a.md", "b.md"]]));
    const { hash, positions } = readLayoutCache(root)!;
    writeFileSync(join(root, ".state", "graph-layout-assertions.json"), JSON.stringify({ hash, positions }));
    graphWithLayout(root, graph("h2", ["a.md", "b.md", "c.md"], [["a.md", "b.md"]]));
    expect(readLayoutCache(root)!.neighbours).toBeDefined();
  });

  test("an unwritable .state costs a re-settle, never the request", () => {
    const root = fresh();
    chmodSync(root, 0o500); // no write: mkdir/writeFile inside will fail
    try {
      const g = graphWithLayout(root, graph("h1", ["a.md", "b.md"]));
      expect(typeof g.nodes[0]!.x).toBe("number"); // still a usable picture
      expect(existsSync(join(root, ".state", "graph-layout-assertions.json"))).toBe(false);
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

describe("assertionGraphCached", () => {
  for (const verdict of ["declined", "filed"] as const) {
    for (const holdWal of [false, true]) {
      test(`${verdict} replaces a cached spinner before the watcher fires (${holdWal ? "live WAL" : "checkpointed database"})`, () => {
        const root = fresh();
        const drop = insertion({ id: "ins_111111111111111111111111", title: "A forwarded message" });
        appendSourceInsertionEvent(root, drop);
        projectSourceInsertion(root, drop);
        // Another process can keep the WAL open while the gardener writes.
        const reader = holdWal ? openAssertionProjectionReadonly(root) : undefined;
        try {
          const first = assertionGraphCached(root);
          expect(first.nodes.find((n) => n.id === `source:${drop.id}`)?.pending).toBe(true);
          expect(assertionGraphCached(root)).toBe(first);
          const sources = new Map([[drop.id, drop]]);
          const author = { kind: "model" as const, id: "gardener", invocation_id: "run-1" };
          const produced_by = { procedure: "intake", version: "v1" };
          const created_at = "2026-09-07T21:00:00.000Z";
          if (verdict === "declined") {
            appendAndProjectDecline(root, createDeclineEvent({
              insertion_ids: [drop.id], reason: "Nothing to keep", author, produced_by, created_at,
            }, sources));
          } else {
            const ada = { id: assertionEntityId("Ada"), label: "Ada" };
            appendAndProjectAssertion(root, createAssertionEvent({
              text: `[[${ada.id}|Ada]] sent the forwarded message.`, entities: [ada], sources: [drop.id],
              author, produced_by, created_at, confidence: "direct",
            }, sources));
          }
          expect(recentFromSourceLog(root)[0]!.status).toBe(verdict);
          // No invalidateGraphCaches, no timer: the very next request must
          // agree with the feed even if the watcher is late or unavailable.
          const next = assertionGraphCached(root);
          const node = next.nodes.find((n) => n.id === `source:${drop.id}`);
          expect(node?.degree).toBe(verdict === "declined" ? 0 : 1);
          expect(node?.pending).toBeUndefined();
          expect(next.hash).not.toBe(first.hash);
          expect(assertionGraphCached(root)).toBe(next);
        } finally {
          reader?.close();
        }
      });
    }
  }

  test("the same revision reuses the same graph", () => {
    const root = fresh();
    const first = assertionGraphCached(root);
    expect(assertionGraphCached(root)).toBe(first);
  });

  test("roots memoize independently", () => {
    const a = assertionGraphCached(fresh());
    const b = assertionGraphCached(fresh());
    expect(a).not.toBe(b);
  });
});

test("periodic reconciliation preserves an unchanged graph rather than expiring it", async () => {
  const { invalidateGraphCaches } = await import("../lib/graphCache");
  const root = fresh();
  const now = Date.now;
  try {
    const first = assertionGraphCached(root);
    Date.now = () => now() + 120_000;
    expect(assertionGraphCached(root)).toBe(first);
    invalidateGraphCaches(root);
    const changed = assertionGraphCached(root);
    expect(changed).not.toBe(first);
    Date.now = () => now() + 240_000;
    expect(assertionGraphCached(root)).toBe(changed);
  } finally { Date.now = now; }
});
