import { expect, test } from "bun:test";
import { rankNavigationSearch, navigationTextTier } from "../lib/navigationSearch";
import { graphImportance } from "../lib/graphImportance";
import { withPilotSearch } from "../web/ui/src/lib/pilotSearch";
import { newPilotChatSession } from "../lib/pilotChatTypes";
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
test("ATLAS's exact project name beats broader memory titles, recent sources, and old Pilot echoes", () => {
  const old = newPilotChatSession([], `pilot-${"a".repeat(32)}`);
  old.title = "How ATLAS's severity graph could improve";
  old.messages = [{ id: "m", role: "assistant", text: "ATLAS research", at: old.created }];
  const hits = [hit("sources/atlas", "ATLAS", Date.now()), hit("memory/atlas", "ATLAS — the current project"),
    hit("projection/entities/atlas", "ATLAS", 0, "projection/entities")];
  for (const mention of [false, true]) {
    const ranked = withPilotSearch(hits, [old], "atlas", { graph, mention });
    expect(ranked[0]!.note.path).toBe("projection/entities/atlas");
    expect(ranked.findIndex(h => h.dir === "pilot")).toBeGreaterThan(0);
    expect(ranked[0]!.searchImportance).toBe(graphImportance(graph).scores[0]);
  }
});
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
test("coalescing a Pilot chapter retains its importance but removes its unconditional priority", () => {
  const s = newPilotChatSession([], `pilot-${"b".repeat(32)}`); s.title = "ATLAS";
  s.ingestions = [{ path: "chapter", sourceId: "s", insertionId: "i", through: 0 }];
  const ranked = withPilotSearch([{ ...hit("chapter", "ATLAS"), searchImportance: 0.5 },
    { ...hit("project", "ATLAS", 0, "projection/entities"), searchImportance: 0.9 }], [s], "atlas");
  expect(ranked.map(h => h.note.path)).toEqual(["project", s.id]);
  expect(ranked[1]!.searchImportance).toBe(0.5);
});
