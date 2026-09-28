import { expect, test } from "bun:test";
import { connectedMentions, boostConnectedMentions } from "../web/ui/src/lib/pilotMentionSuggestions";
import type { GraphData } from "../web/ui/src/lib/types";

const graph: GraphData = { hash: "sample", nodes: [
  { id: "memory/theme.md", path: "memory/theme.md", title: "Theme", group: "memory", degree: 3 },
  { id: "a", path: "notes/a.md", title: "Discussed", group: "entity", degree: 1 },
  { id: "b", path: "notes/b.md", title: "Strong connection", group: "source", degree: 50 },
  { id: "c", path: "notes/c.md", title: "Unrelated popular item", group: "source", degree: 1000 },
  { id: "pilot-1", path: "pilot-1", title: "Agent", group: "pilot", degree: 5 },
], edges: [ { source: "memory/theme.md", target: "a", weight: 1 },
  { source: "b", target: "memory/theme.md", weight: 10 },
  { source: "memory/theme.md", target: "pilot-1" } ] };

test("explicit memory links lead, then connection strength; unrelated popularity and agents are excluded", () => {
  const result = connectedMentions(graph, ["memory/theme.md"], { "memory/theme.md": "About [[notes/a|Discussed]]" });
  expect(result.label).toBe("Connected to Theme");
  expect(result.items.map(n => n.id)).toEqual(["notes/a.md", "notes/b.md"]);
  expect(result.items[0].hint).toBe("Mentioned in Theme");
  expect(result.items[1].hint).toBe("Connected to Theme");
});
test("missing memory text still supplies graph connections and multiple attachments deduplicate", () => {
  expect(connectedMentions(graph, ["memory/theme.md", "memory/theme.md"], {}).items.map(n => n.id))
    .toEqual(["notes/b.md", "notes/a.md"]);
  expect(connectedMentions(null, ["missing"], {}).items).toEqual([]);
});
test("typed search keeps global matches and only modestly boosts context", () => {
  const hits = Array.from({length: 8}, (_, i) => ({id: `item-${i}`, title: `Item ${i}`, tag: "SOURCE" as const}));
  const result = boostConnectedMentions(hits, [{...hits[7], hint: "Connected to Theme"}]);
  expect(result.map(n => n.id)).toEqual(["item-0", "item-1", "item-2", "item-3", "item-4", "item-7", "item-5", "item-6"]);
  expect(result[5].hint).toBe("Connected to Theme");
});
