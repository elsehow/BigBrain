import { expect, test } from "bun:test";
import { buildField } from "../web/ui/src/lib/v2/model";
import type { GraphData } from "../web/ui/src/lib/types";

const entity = (id: string, x: number) => ({ id, title: id, group: "entity", entity: true, degree: 1, path: `projection/entities/${id}.md`, x, y: x });
const memory = (slug: string, title: string, x: number) => ({ id: `memory/${slug}.md`, title, group: "memory", degree: 2, path: `memory/${slug}.md`, x, y: -x });
const graph = (...memories: ReturnType<typeof memory>[]) =>
  ({ hash: "h", nodes: [entity("ent_a", 10), entity("ent_b", -10), ...memories], edges: [] }) as unknown as GraphData;
const drawn = (g: GraphData) => buildField(g).nodes.map((n) => n.id).sort();

test("MEMORY.md alone is not drawn", () => {
  expect(drawn(graph(memory("MEMORY", "Memory", 0)))).toEqual(["ent_a", "ent_b"]);
});

test("MEMORY.md beside topic files is drawn as before", () => {
  expect(drawn(graph(memory("MEMORY", "Memory", 0), memory("atlas", "Atlas", 5))))
    .toEqual(["ent_a", "ent_b", "memory/MEMORY.md", "memory/atlas.md"]);
});

test("a lone topic file that is not the index is still drawn", () => {
  expect(drawn(graph(memory("atlas", "Atlas", 5)))).toEqual(["ent_a", "ent_b", "memory/atlas.md"]);
});
