import { expect, test } from "bun:test";
import { placeLenses, type Field } from "../web/ui/src/lib/v2/model";

// two clusters of invented entities, placed directly in field space: three
// to the west, two to the east
const spots: Array<[string, number, number]> = [["west_a", -12, -4], ["west_b", -11, -3], ["west_c", -12.5, -2.5], ["east_a", 12, -4], ["east_b", 13, -3]];
const nodes = spots.map(([id, x, z], i) => ({ i, id, label: id, path: `projection/entities/${id}.md`, degree: 2, memory: false, named: true, p: [x, 3, z] as [number, number, number] }));
const field = { nodes, byId: new Map(nodes.map((n) => [n.id, n.i])), edges: [], strong: [], hubs: new Set<number>() } as unknown as Field;
const at = (id: string) => field.nodes[field.byId.get(id)!]!.p;
// a lens's entities arrive as /api/lenses/entities serves them: what its members' claims name
const place = (entities: string[]) => placeLenses(field, [{ id: "lens_000000000001", name: "Westward", entities }])[0]!;
const near = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0]! - q[0]!, p[2]! - q[2]!);

test("a lens stands among what it holds, in the field's own band", () => {
  const d = place(["west_a", "west_b", "west_c"]);
  expect(near(d.p, at("west_a"))).toBeLessThan(near(d.p, at("east_a")));
  expect(Math.abs(d.p[1] - at("west_a")[1])).toBeLessThan(2);
  expect(d.ctx.length).toBe(3);
});

test("it stands at the average of the entities it holds", () => {
  const d = place(["west_a", "east_a"]);
  expect(d.p[0]).toBeCloseTo(0, 6);
  expect(d.p[2]).toBeCloseTo(-4, 6);
});

test("an entity counts once, however many members name it", () => {
  expect(place(["west_a", "east_a", "east_a"]).p).toEqual(place(["west_a", "east_a"]).p);
});

test("the order entities come in makes no difference", () => {
  const ids = ["east_a", "west_a", "west_b", "east_b", "west_c"];
  const a = place(ids).p, b = place([...ids].reverse()).p;
  for (let d = 0; d < 3; d++) expect(a[d]!).toBeCloseTo(b[d]!, 9);
});

test("an entity the field doesn't draw places nothing; with nothing placeable it waits above the middle", () => {
  const d = place(["ent_elsewhere"]);
  expect(d.ctx).toEqual([]);
  expect(d.p[1]).toBeGreaterThan(5);
});

test("lenses over the same entities are pushed apart, and the field never moves", () => {
  const before = JSON.stringify(field.nodes.map((n) => n.p));
  const [a, b] = placeLenses(field, [{ id: "lens_000000000001", name: "One", entities: ["west_a"] }, { id: "lens_000000000002", name: "Two", entities: ["west_a"] }]);
  expect(near(a!.p, b!.p)).toBeGreaterThan(2.3);
  expect(JSON.stringify(field.nodes.map((n) => n.p))).toBe(before);
});

test("a lens still being scored turns; a settled one stands still", () => {
  const [busy, still] = placeLenses(field, [{ id: "lens_000000000001", name: "One", working: true, entities: [] }, { id: "lens_000000000002", name: "Two", entities: [] }]);
  expect([busy!.working, still!.working]).toEqual([true, false]);
});
