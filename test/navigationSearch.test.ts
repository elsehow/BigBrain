import { expect, test } from "bun:test";
import { rankNavigationSearch, navigationTextTier } from "../lib/navigationSearch";
import type { SearchHit } from "../web/ui/src/lib/omnibox.svelte";

const hit = (path: string, title: string, modified = 0, dir = "source"): SearchHit => ({
  title, dir, snippet: "", note: { path, name: title, modified, size: 0 },
});
const graph = {
  nodes: [
    { id: "project", path: "projection/entities/atlas", title: "ATLAS", group: "entity", memorySupport: 2, degree: 1 },
    { id: "memory", path: "memory/atlas", title: "ATLAS — the current project", group: "memory", degree: 1 },
    { id: "source", path: "sources/atlas", title: "ATLAS", group: "source", degree: 1 },
    { id: "hub", path: "sources/hub", title: "ATLAS", group: "source", degree: 3 },
  ],
  edges: [{ source: "memory", target: "project" }, { source: "hub", target: "source" },
    { source: "hub", target: "project" }, { source: "hub", target: "memory" }],
};
test("memory support outranks a busier hub at the same textual relevance; connectivity resolves unsupported ties", () => {
  const hits = [hit("sources/hub", "ATLAS", 100), hit("sources/atlas", "ATLAS", 200), hit("projection/entities/atlas", "ATLAS")];
  expect(rankNavigationSearch(hits, "atlas", graph).map(h => h.note.path))
    .toEqual(["projection/entities/atlas", "sources/hub", "sources/atlas"]);
});
test("mentions prefer the project over an equally named Pilot even if the Pilot is more prominent", () => {
  const pilot = { ...hit("pilot-a", "ATLAS", Date.now(), "pilot"), searchImportance: 1.6 };
  const project = { ...hit("project", "ATLAS", 0, "projection/entities"), searchImportance: 0.9 };
  expect(rankNavigationSearch([pilot, project], "atlas", null, true)[0]).toMatchObject({ dir: "projection/entities" });
  // The general search keeps the requested text-first, importance-second policy.
  expect(rankNavigationSearch([project, pilot], "atlas")[0]).toMatchObject({ dir: "pilot" });
  expect(rankNavigationSearch([project, { ...pilot, title: "ATLAS planning" }], "atlas")[0]).toMatchObject({ dir: "projection/entities" });
});
test("aliases and normalized names match exactly; query errors do not crash optimistic UI ranking", () => {
  expect(navigationTextTier("atlas", { title: "Atlas Mapping Toolkit", alias: "ATLAS" })).toBe(0);
  expect(navigationTextTier("automap", { title: "Auto-MAP" })).toBe(0);
  expect(navigationTextTier("cafe", { title: "Café" })).toBe(0);
  expect(navigationTextTier("atlas", { title: "ATLAS planning" })).toBe(1);
  expect(navigationTextTier("atlas", { title: "Research findings" })).toBe(2);
  expect(() => navigationTextTier("OR", { title: "Research" })).not.toThrow();
});
