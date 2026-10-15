import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Graph } from "../lib/graph";
import { edgeKey, fieldLayout, seatLayout, type Positions } from "../lib/views/layout";

// The field is the seats settled into the shape of the ties.
const node = (id: string) => ({ id, title: id, group: "entity", degree: 1 });
const graph = (ids: string[], links: [string, string][]): Graph =>
  ({ nodes: ids.map(node), edges: links.map(([source, target]) => ({ source, target })), hash: ids.join(",") });
const dist = (at: Positions, a: string, b: string) => {
  const dx = at[a]![0] - at[b]![0], dy = at[a]![1] - at[b]![1];
  return Math.sqrt(dx * dx + dy * dy);
};
const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;

// Two circles of friends, one tie between them, that arrived interleaved: the
// seats mix them, as they arrived; the field draws two groups.
const left = ["ada", "bea", "cal", "dot", "eve", "fay"], right = ["gus", "hal", "ivy", "jon", "kit", "lou"];
const clique = (ids: string[]) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as [string, string]));
const ids = left.flatMap((id, i) => [id, right[i]!]);
const links = [...clique(left), ...clique(right), ["ada", "gus"] as [string, string]];
const arrivals = new Map<string, string>(ids.map((id, i) => [id, String(i).padStart(2, "0")] as const));
for (const [a, b] of links) arrivals.set(edgeKey(a, b), "99"); // every tie made after both ends: no seat follows one
const twoGroups = graph(ids, links);

test("connected things sit together: within a group closer than across", () => {
  const at = fieldLayout(twoGroups, arrivals);
  const within = mean([...clique(left), ...clique(right)].map(([a, b]) => dist(at, a, b)));
  const across = mean(left.flatMap((a) => right.map((b) => dist(at, a, b))));
  expect(within * 2).toBeLessThan(across);
  // the seats alone don't: they draw when things arrived
  const seats = seatLayout(twoGroups, arrivals);
  expect(mean([...clique(left), ...clique(right)].map(([a, b]) => dist(seats, a, b))) * 2).toBeGreaterThan(mean(left.flatMap((a) => right.map((b) => dist(seats, a, b)))));
});

test("the same record draws the same field, every time", () => {
  expect(fieldLayout(twoGroups, arrivals)).toEqual(fieldLayout(twoGroups, arrivals));
});

test("a leaf sits beside its one tie; what is tied to nothing rings the rest", () => {
  const g = graph([...ids, "leaf", "lone", "stray"], [...links, ["leaf", "cal"]]);
  const at = fieldLayout(g, arrivals);
  const others = ids.filter((id) => id !== "cal");
  expect(dist(at, "leaf", "cal")).toBeLessThan(Math.min(...others.map((id) => dist(at, "leaf", id))));
  const r = (id: string) => Math.sqrt(at[id]![0] * at[id]![0] + at[id]![1] * at[id]![1]);
  const reach = Math.max(...[...ids, "leaf"].map(r));
  for (const id of ["lone", "stray"]) expect(r(id)).toBeGreaterThan(reach);
  expect(dist(at, "lone", "stray")).toBeGreaterThan(1);
});

test("fixed places stay exactly; the rest settle beside what they link", () => {
  const mine = fieldLayout(twoGroups, arrivals);
  const union = graph([...ids, "server:mo", "server:nan"], [...links, ["server:mo", "fay"], ["server:mo", "eve"], ["server:nan", "server:mo"]]);
  const later = new Map([...arrivals, ["server:mo", "a0"], ["server:nan", "a1"], [edgeKey("server:mo", "fay"), "a0"], [edgeKey("server:mo", "eve"), "a0"], [edgeKey("server:nan", "server:mo"), "a1"]]);
  const at = fieldLayout(union, later, mine);
  for (const [id, place] of Object.entries(mine)) expect(at[id]).toEqual(place);
  expect(fieldLayout(union, later, mine)).toEqual(at);
  expect(dist(at, "server:mo", "fay")).toBeLessThan(mean(right.map((id) => dist(at, "server:mo", id))));
});

test("the layout uses only arithmetic every engine rounds alike", () => {
  const code = readFileSync(new URL("../lib/views/layout.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(code).not.toMatch(/Math\.(sin|cos|tan|atan2?|hypot|pow|exp|log\w*|cbrt|random)\b|\w\s*\*\*\s*[\w(]/);
});
