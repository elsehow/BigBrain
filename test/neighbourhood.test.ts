import { describe, expect, test } from "bun:test";
import { findNode, withinHops, neighbourhoodCut, neighbourhoodHidden } from "../web/ui/src/lib/neighbourhood";
import type { GraphData, GraphNode } from "../web/ui/src/lib/types";

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: id,
  group: "reference",
  degree: 0,
  ...extra,
});

// The legacy link graph: a node's id IS the vault-relative path.
const LEGACY: GraphData = {
  nodes: [
    node("references/a.md"),
    node("references/b.md"),
    node("entities/c.md", { group: "entity", entity: true }),
    node("references/far.md"),
  ],
  edges: [
    { source: "references/a.md", target: "references/b.md" },
    { source: "references/a.md", target: "entities/c.md" },
    // neighbour↔neighbour — local structure the cut must keep
    { source: "references/b.md", target: "entities/c.md" },
    { source: "entities/c.md", target: "references/far.md" },
  ],
  hash: "legacy1",
};

// The assertion projection: sources id'd as source:<insertion id>, entities
// by entity id — the openable note lives in `path`, never in `id`.
const ASSERTION: GraphData = {
  nodes: [
    node("source:evt1", { group: "source", path: "log/insertions/2026-08/evt1.json" }),
    node("source:evt2", { group: "source", path: "log/insertions/2026-08/evt2.json" }),
    node("person:ada", { group: "entity", entity: true, path: "projection/entities/person:ada.md" }),
  ],
  edges: [
    { source: "person:ada", target: "source:evt1" },
    { source: "person:ada", target: "source:evt2" },
  ],
  hash: "assert1",
};

describe("neighbourhoodCut", () => {
  test("legacy projection: resolves by id and keeps 1-hop structure", () => {
    const cut = neighbourhoodCut(LEGACY, "references/a.md");
    expect(cut).not.toBeNull();
    expect(cut!.nodes.map((n) => n.id).sort()).toEqual([
      "entities/c.md",
      "references/a.md",
      "references/b.md",
    ]);
    // the neighbour↔neighbour edge survives; the far edge is cut
    expect(cut!.edges).toContainEqual({ source: "references/b.md", target: "entities/c.md" });
    expect(cut!.edges).not.toContainEqual({ source: "entities/c.md", target: "references/far.md" });
  });

  test("assertion projection: a source note resolves by node.path", () => {
    const cut = neighbourhoodCut(ASSERTION, "log/insertions/2026-08/evt1.json");
    expect(cut).not.toBeNull();
    expect(cut!.nodes.map((n) => n.id).sort()).toEqual(["person:ada", "source:evt1"]);
    expect(cut!.edges).toEqual([{ source: "person:ada", target: "source:evt1" }]);
  });

  test("assertion projection: a projected entity note resolves by node.path", () => {
    const cut = neighbourhoodCut(ASSERTION, "projection/entities/person:ada.md");
    expect(cut).not.toBeNull();
    expect(cut!.nodes.map((n) => n.id).sort()).toEqual(["person:ada", "source:evt1", "source:evt2"]);
  });

  test("a note the graph does not draw cuts to null", () => {
    expect(neighbourhoodCut(ASSERTION, "log/insertions/2026-08/uncited.json")).toBeNull();
    expect(neighbourhoodCut(LEGACY, "references/unlinked.md")).toBeNull();
  });

  test("an isolated node cuts to null — the panel says so instead of drawing one dot", () => {
    const lonely: GraphData = {
      nodes: [node("references/a.md")],
      edges: [],
      hash: "h",
    };
    expect(neighbourhoodCut(lonely, "references/a.md")).toBeNull();
  });

  test("the cut's structure key is per-centre, on top of the full graph's", () => {
    const a = neighbourhoodCut(ASSERTION, "log/insertions/2026-08/evt1.json");
    const b = neighbourhoodCut(ASSERTION, "log/insertions/2026-08/evt2.json");
    expect(a!.hash).toBe("assert1~source:evt1");
    expect(a!.hash).not.toBe(b!.hash);
  });
});

describe("neighbourhoodHidden", () => {
  // A meeting note's neighbourhood: the open note (agent-filed), a sibling
  // filed by the same agent session, a granola arrival, and an entity.
  const CENTRE = "log/insertions/2026-08/mine.json";
  const CUT: GraphData = {
    nodes: [
      node("source:mine", {
        group: "source", path: CENTRE,
        band: "agent", via: "claude code on Mac-mini.local",
      }),
      node("source:sibling", {
        group: "source", path: "log/insertions/2026-08/sibling.json",
        band: "agent", via: "claude code on Mac-mini.local",
      }),
      node("source:meeting", {
        group: "source", path: "log/insertions/2026-08/meeting.json",
        band: "service", via: "granola",
      }),
      node("person:ada", { group: "entity", entity: true, path: "projection/entities/person:ada.md" }),
    ],
    edges: [],
    hash: "h",
  };

  test("an off-by-default agent hides its neighbours — never the open note", () => {
    const hidden = neighbourhoodHidden(CUT, CENTRE, {});
    expect(hidden.has("source:sibling")).toBe(true);
    expect(hidden.has("source:mine")).toBe(false); // the centre is exempt
    expect(hidden.has("source:meeting")).toBe(false); // granola defaults ON
    expect(hidden.has("person:ada")).toBe(false); // entities are nobody's filing
  });

  test("an explicit choice wins in the neighbourhood, same as on home", () => {
    expect(
      neighbourhoodHidden(CUT, CENTRE, { "claude code on Mac-mini.local": true }).size
    ).toBe(0);
    expect(
      neighbourhoodHidden(CUT, CENTRE, { granola: false }).has("source:meeting")
    ).toBe(true);
  });

  test("a legacy cut without filer facets hides nothing", () => {
    const legacy: GraphData = {
      nodes: [node("references/a.md"), node("references/b.md")],
      edges: [{ source: "references/a.md", target: "references/b.md" }],
      hash: "h",
    };
    expect(neighbourhoodHidden(legacy, "references/a.md", {}).size).toBe(0);
  });
});

// The feed-row → node join, shared with LinkGraph's `highlight` (the
// selected row lit as a hover would light it, 2026-09-03).
describe("findNode: a row's path finds its node by path or by id", () => {
  const nodes = [
    { id: "source:ins_1", path: "log/2026-09/ins_1.json" },
    { id: "references/a.md", path: null },
    { id: "ent_x", path: "entities/x.md" },
  ];
  test("native ids match on path, legacy graphs on id, else -1", () => {
    expect(findNode(nodes, "log/2026-09/ins_1.json")).toBe(0);
    expect(findNode(nodes, "references/a.md")).toBe(1);
    expect(findNode(nodes, "entities/x.md")).toBe(2);
    expect(findNode(nodes, "ent_x")).toBe(2);
    expect(findNode(nodes, "nope.md")).toBe(-1);
  });
});


test("two-hop framing includes indirect neighbors once, excluding third hops and disconnected nodes", () => {
  const adjacency = [[1, 2], [0, 2, 3], [0, 1], [1, 4], [3], []];
  expect(withinHops(adjacency, 0, 2)).toEqual([0, 1, 2, 3]);
  expect(withinHops(adjacency, 0, 0)).toEqual([0]);
  expect(withinHops(adjacency, 5, 2)).toEqual([5]);
  expect(withinHops(adjacency, -1, 2)).toEqual([]);
});

test("feed selection resolves every transcript alias to its session node", () => {
  const nodes = [node("session", { path: "sessions/work.md", memberPaths: ["thread-member.json"], sourcePaths: ["captured-chat.json"] })];
  for (const key of ["session", "sessions/work.md", "thread-member.json", "captured-chat.json"]) {
    expect(findNode(nodes, key)).toBe(0);
  }
  expect(findNode(nodes, "unknown.json")).toBe(-1);
});
