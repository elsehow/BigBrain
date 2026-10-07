import { expect, test } from "bun:test";
import { buildField } from "../web/ui/src/lib/v2/model";
import type { GraphData } from "../web/ui/src/lib/types";

const entity = (id: string, x: number, y: number) => ({ id, title: id, group: "entity", entity: true, degree: 2, path: `projection/entities/${id}.md`, x, y });
const source = (id: string, x?: number, y?: number) => ({ id: `source:${id}`, title: `Note ${id}`, group: "source", degree: 1, path: `log/insertions/2026-10/${id}.json`, x, y });
const field = buildField({ hash: "h", nodes: [
  entity("ent_a", 0, 0), entity("ent_b", 100, 0), entity("ent_c", 0, 100), entity("ent_d", -100, -100),
  source("ins_1", 50, 0), source("ins_2"), source("ins_3"),
], edges: [
  { source: "ent_a", target: "ent_b", weight: 2 },
  { source: "source:ins_1", target: "ent_a" }, { source: "source:ins_1", target: "ent_b" },
  { source: "ent_c", target: "source:ins_2" },
] } as unknown as GraphData);

test("sources stay out of the entity nodes and their ties", () => {
  expect(field.nodes.map((n) => n.id)).toEqual(["ent_a", "ent_b", "ent_c", "ent_d"]);
  expect(field.edges).toEqual([[0, 1, 2]]);
});

test("each source carries its path and the entities it mentions", () => {
  const [one, two] = field.sources;
  expect(one).toMatchObject({ id: "source:ins_1", label: "Note ins_1", paths: ["log/insertions/2026-10/ins_1.json"] });
  expect(one!.ties.sort()).toEqual([0, 1]);
  expect(two!.ties).toEqual([2]);
});

test("a laid-out source sits between what it mentions; an unplaced one over it; a lone unplaced one is left out", () => {
  const [one, two] = field.sources;
  const [a, b, c] = field.nodes;
  expect(one!.p[0]).toBeGreaterThan(Math.min(a!.p[0], b!.p[0]));
  expect(one!.p[0]).toBeLessThan(Math.max(a!.p[0], b!.p[0]));
  expect([two!.p[0], two!.p[2]]).toEqual([c!.p[0], c!.p[2]]);
  expect(field.sources.map((s) => s.id)).not.toContain("source:ins_3");
});

// an entity that IS a source (the server's `opens` / `drawnAs`): one node
const linkedGraph = (link: boolean) => ({ hash: "h", nodes: [
  { ...entity("ent_p", 0, 0), ...(link ? { opens: ["source:ins_new", "source:ins_old"] } : {}) }, entity("ent_q", 100, 0),
  { ...source("ins_old", 10, 0), memberPaths: ["log/insertions/2026-09/ins_old_2.json"], ...(link ? { drawnAs: "ent_p" } : {}) },
  { ...source("ins_new", 20, 0), ...(link ? { drawnAs: "ent_p" } : {}) },
  { ...source("ins_x", 50, 0), drawnAs: "ent_gone" },
], edges: [
  { source: "ent_p", target: "ent_q", weight: 3 },
  { source: "source:ins_old", target: "ent_p" }, { source: "source:ins_x", target: "ent_q" },
] } as unknown as GraphData);

test("a source drawn as an entity has no dot of its own; its paths are the entity's, in its order, and the entity is unchanged", () => {
  const linked = buildField(linkedGraph(true)), plain = buildField(linkedGraph(false));
  expect(linked.sources.map((s) => s.id)).toEqual(["source:ins_x"]);
  expect(linked.nodes[0]!.opens).toEqual(["log/insertions/2026-10/ins_new.json", "log/insertions/2026-10/ins_old.json", "log/insertions/2026-09/ins_old_2.json"]);
  expect(linked.nodes[1]!.opens).toBeUndefined();
  expect(linked.nodes.map((n) => n.p)).toEqual(plain.nodes.map((n) => n.p));
  expect(linked.edges).toEqual(plain.edges);
  expect([...linked.hubs]).toEqual([...plain.hubs]);
});

test("a source drawn as an entity that isn't in the field stays a source", () => {
  const [x] = buildField(linkedGraph(true)).sources;
  expect(x).toMatchObject({ id: "source:ins_x", paths: ["log/insertions/2026-10/ins_x.json"], ties: [1] });
});

test("entities bound to one source each open it; it has no dot of its own, drawn as the first", () => {
  const f = buildField({ hash: "h", nodes: [
    { ...entity("ent_a", 0, 0), opens: ["source:ins_1"] }, { ...entity("ent_b", 100, 0), opens: ["source:ins_gone", "source:ins_1"] },
    { ...source("ins_1", 50, 0), drawnAs: "ent_a" },
  ], edges: [] } as unknown as GraphData);
  expect(f.sources).toEqual([]);
  expect(f.nodes.map((n) => n.opens)).toEqual([["log/insertions/2026-10/ins_1.json"], ["log/insertions/2026-10/ins_1.json"]]);
});
