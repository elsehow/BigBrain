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
