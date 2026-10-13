import { expect, test } from "bun:test";
import type { Graph } from "../lib/graph";
import { edgeKey, seatLayout } from "../lib/views/layout";

// A picture can extend another: what was seated stays, the rest sit around it.
const node = (id: string) => ({ id, title: id, group: "entity", degree: 1 });
const graph = (ids: string[], links: [string, string][]): Graph =>
  ({ nodes: ids.map(node), edges: links.map(([source, target]) => ({ source, target })), hash: ids.join(",") });

test("with nothing fixed, the picture is the one seatLayout always drew", () => {
  const g = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
  const arrivals = new Map([["a", "1"], ["b", "2"], ["c", "3"], [edgeKey("a", "b"), "2"], [edgeKey("b", "c"), "3"]]);
  expect(seatLayout(g, arrivals, {})).toEqual(seatLayout(g, arrivals));
});

test("fixed seats stay exactly where they were; the new nodes sit beside what they link, apart, the same every time", () => {
  const mine = graph(["ada", "orchard", "river"], [["ada", "orchard"], ["ada", "river"]]);
  const arrivals = new Map([["ada", "1"], ["orchard", "2"], ["river", "3"], [edgeKey("ada", "orchard"), "2"], [edgeKey("ada", "river"), "3"]]);
  const fixed = seatLayout(mine, arrivals);
  const theirs = ["server:barn", "server:kiln", "server:lone"];
  const union = graph([...mine.nodes.map((n) => n.id), ...theirs], [["ada", "orchard"], ["ada", "river"], ["ada", "server:barn"], ["server:barn", "server:kiln"]]);
  const later = new Map([...arrivals, ["server:barn", "4"], ["server:kiln", "5"], ["server:lone", "6"],
    [edgeKey("ada", "server:barn"), "4"], [edgeKey("server:barn", "server:kiln"), "5"]]);
  const at = seatLayout(union, later, fixed);
  for (const [id, seat] of Object.entries(fixed)) expect(at[id]).toEqual(seat);
  expect(seatLayout(union, later, fixed)).toEqual(at);
  const dist = (a: string, b: string) => Math.hypot(at[a]![0] - at[b]![0], at[a]![1] - at[b]![1]);
  expect(dist("server:barn", "ada")).toBeLessThan(40); // beside what it arrived linked to
  const ids = Object.keys(at);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(dist(ids[i]!, ids[j]!)).toBeGreaterThan(3);
});
