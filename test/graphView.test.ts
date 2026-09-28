import { expect, test } from "bun:test";
import { canonicalGraphView, changeGraphView, graphViewAction, normalizeGraphView, resolveGraphView } from "../lib/graphView";

// A—C—B, with an additional D neighbor of B, and an unrelated E.
const ids = ["A", "B", "C", "D", "E"];
const adj = [[2], [2, 3], [0, 1], [1], []];
const empty = { selected: [], excluded: [] };

test("path and source aliases canonicalize before exclusion and deduplication", () => {
  expect(canonicalGraphView([{ id: "a", path: "a.md", memberPaths: ["old.md"] }, { id: "b", path: "b.md" }], {
    selected: ["a", "old.md", "b.md", "missing"], excluded: ["a.md"],
  })).toEqual({ selected: ["b", "missing"], excluded: ["a"] });
});
const members = (state: typeof empty | { selected: string[]; excluded: string[] }) =>
  [...resolveGraphView(ids, adj, state).visible].map(i => ids[i]).sort();

test("compose neighborhoods, prune a shared neighbor, undo by restoring state", () => {
  const a = changeGraphView(empty, { type: "select", id: "A" });
  expect(members(a)).toEqual(["A", "C"]);
  const joint = changeGraphView(a, { type: "add", id: "B" });
  expect(members(joint)).toEqual(["A", "B", "C", "D"]);
  const pruned = changeGraphView(joint, { type: "exclude", id: "C" });
  expect(members(pruned)).toEqual(["A", "B", "D"]);
  expect(members(joint)).toEqual(["A", "B", "C", "D"]);
  expect(changeGraphView(pruned, { type: "restore", id: "C" })).toEqual(joint);
  expect(changeGraphView(pruned, { type: "add", id: "C" })).toEqual({ selected: ["A", "B", "C"], excluded: [] });
});

test("removing an anchor drops its contribution, including unique neighbors", () => {
  const state = changeGraphView({ selected: ["A", "B"], excluded: [] }, { type: "exclude", id: "B" });
  expect(members(state)).toEqual(["A", "C"]);
  expect(state).toEqual({ selected: ["A"], excluded: ["B"] });
  expect(changeGraphView(state, { type: "select", id: "E" })).toEqual({ selected: ["E"], excluded: [] });
});

test("empty selection returns to overview, respecting exclusions and unknown IDs", () => {
  const overview = new Uint8Array([1, 0, 1, 0, 0]);
  expect([...resolveGraphView(ids, adj, { selected: [], excluded: ["C"] }, overview).visible]).toEqual([0]);
  expect(members({ selected: ["missing"], excluded: [] })).toEqual([]);
  expect(members({ selected: ["E"], excluded: [] })).toEqual(["E"]);
  expect(members(changeGraphView({ selected: ["A"], excluded: ["C"] }, { type: "clear" }))).toEqual(ids);
});

test("state round-trips independently of click order, graph order, or duplicate entries", () => {
  const state = normalizeGraphView({ selected: ["B", "A", "B", "C"], excluded: ["C", "C"] });
  expect(state).toEqual({ selected: ["A", "B"], excluded: ["C"] });
  expect(members(JSON.parse(JSON.stringify(state)))).toEqual(["A", "B", "D"]);
  const reversed = resolveGraphView([...ids].reverse(), [...adj].reverse().map(ns => ns.map(i => 4 - i)), state);
  expect([...reversed.visible].map(i => [...ids].reverse()[i]).sort()).toEqual(["A", "B", "D"]);
  expect(graphViewAction("A", { ctrlKey: true, shiftKey: true }).type).toBe("exclude");
  expect(graphViewAction("A", { ctrlKey: false, shiftKey: true }).type).toBe("add");
  expect(graphViewAction("A", { ctrlKey: false, shiftKey: false }).type).toBe("select");
});
