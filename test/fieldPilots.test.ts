import { expect, test } from "bun:test";
import { placePilots, type Field, type PilotSummary } from "../web/ui/src/lib/v2/model";

// two clusters of invented entities, placed directly in field space: three
// to the west, two to the east
const spots: Array<[string, number, number]> = [["west_a", -12, -4], ["west_b", -11, -3], ["west_c", -12.5, -2.5], ["east_a", 12, -4], ["east_b", 13, -3]];
const nodes = spots.map(([id, x, z], i) => ({ i, id, label: id, path: `projection/entities/${id}.md`, degree: 2, memory: false, named: true, p: [x, 3, z] as [number, number, number] }));
const field = { nodes, byId: new Map(nodes.map((n) => [n.id, n.i])), edges: [], strong: [], hubs: new Set<number>() } as unknown as Field;
const at = (id: string) => field.nodes[field.byId.get(id)!]!.p;
// a source in context arrives as the engine serves it: a context node
// carrying the entities its claims mention (lib/contextSources.ts)
const desk = (context: string[], sources: Record<string, string[]> = {}): PilotSummary => ({ id: "pilot-1", title: "Desk", model: "m", phase: "working", context,
  contextNodes: Object.entries(sources).map(([id, entities]) => ({ id, path: id, title: id, group: "source", entities })) } as PilotSummary);
const place = (context: string[], sources?: Record<string, string[]>) => placePilots(field, [desk(context, sources)])[0]!;
const near = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0]! - q[0]!, p[2]! - q[2]!);

test("a Desktop stands among what it concerns, in the field's own band", () => {
  const d = place(["west_a", "west_b", "west_c"]);
  expect(near(d.p, at("west_a"))).toBeLessThan(near(d.p, at("east_a")));
  expect(Math.abs(d.p[1] - at("west_a")[1])).toBeLessThan(2);
});

test("it stands at the average of the entities it concerns", () => {
  const d = place(["west_a", "east_a"]);
  expect(d.p[0]).toBeCloseTo(0, 6);
  expect(d.p[2]).toBeCloseTo(-4, 6);
});

test("an entity counts once, however many of its notes lead to it", () => {
  const sources = { "sources/report.md": ["east_a"] };
  expect(place(["west_a", "east_a", "sources/report.md", "east_a"], sources).p).toEqual(place(["west_a", "east_a"]).p);
});

test("the order notes were read in makes no difference", () => {
  const ids = ["east_a", "west_a", "west_b", "east_b", "west_c"];
  const a = place(ids).p, b = place([...ids].reverse()).p;
  for (let d = 0; d < 3; d++) expect(a[d]!).toBeCloseTo(b[d]!, 9);
});

test("a source stands where the entities it mentions do", () => {
  const d = place(["sources/report.md"], { "sources/report.md": ["east_a", "east_b"] });
  expect(near(d.p, at("east_a"))).toBeLessThan(3);
  expect(d.ctx.length).toBe(2);
});

test("a context note can be named by its path", () => {
  expect(near(place(["projection/entities/east_b.md"]).p, at("east_b"))).toBeLessThan(2);
});

test("a source the gardener hasn't filed yet places nothing", () => {
  expect(place(["sources/new.md"], { "sources/new.md": [] }).ctx).toEqual([]);
});

test("with nothing placeable it waits above the middle", () => {
  const d = place(["sources/unknown.md"]);
  expect(d.ctx).toEqual([]);
  expect(d.p[1]).toBeGreaterThan(5);
});
