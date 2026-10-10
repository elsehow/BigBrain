import { expect, test } from "bun:test";
import { buildField, searchFound, searchNames, sourceItems } from "../web/ui/src/lib/v2/model";
import type { GraphData } from "../web/ui/src/lib/types";
import type { MentionItem } from "../lib/pilotMentions";

const entity = (id: string, title: string, x: number, y: number) => ({ id, title, group: "entity", entity: true, degree: 2, path: `projection/entities/${id}.md`, x, y });
const source = (id: string, title: string) => ({ id: `source:${id}`, title, group: "source", degree: 1, path: `log/insertions/2026-10/${id}.json`, x: 10, y: 10 });
const field = buildField({ hash: "h", nodes: [
  entity("ent_a", "Kestrel Books", 0, 0), entity("ent_b", "Orrery repair", 100, 0),
  source("ins_1", "Kant reading group notes"), source("ins_2", "Orrery repair estimate"),
], edges: [
  { source: "ent_a", target: "ent_b", weight: 2 },
  { source: "source:ins_1", target: "ent_a" }, { source: "source:ins_2", target: "ent_b" },
] } as unknown as GraphData);
const item = (id: string, title: string, date?: string): MentionItem => ({ id, title, tag: "SOURCE", ...(date ? { date } : {}) });

test("a source isn't an entity: the names alone never find it", () => {
  expect(searchNames(field, "kant")).toEqual([]);
});

test("a source the field draws is found by its title at once, before the vault answers", () => {
  const found = searchFound(field, "kant", searchNames(field, "kant"), sourceItems(field), []);
  expect(found).toEqual([item("log/insertions/2026-10/ins_1.json", "Kant reading group notes")]);
});

test("a recent in hand is found by a word of its title", () => {
  const recents = [item("log/insertions/2026-10/ins_9.json", "a reading on Kant and what follows", "Oct 8 11:48"), item("log/insertions/2026-10/ins_8.json", "Grocery list")];
  expect(searchFound(field, "kant", [], recents, []).map((m) => m.title)).toEqual(["a reading on Kant and what follows"]);
});

test("titles that answer come first, then the vault's matches in the text, in its order", () => {
  const hits = [item("log/insertions/2026-09/ins_x.json", "Seminar minutes"), item("log/insertions/2026-09/ins_y.json", "Notes on Kantian ethics")];
  const found = searchFound(field, "kant", [], sourceItems(field), hits);
  expect(found.map((m) => m.title)).toEqual(["Kant reading group notes", "Notes on Kantian ethics", "Seminar minutes"]);
});

test("one row per path, dated over undated, and nothing the names already list", () => {
  const named = searchNames(field, "orrery");
  expect(named).toEqual([1]);
  const hits = [item("projection/entities/ent_b.md", "Orrery repair"), item("log/insertions/2026-10/ins_2.json", "Orrery repair estimate", "Oct 5")];
  const found = searchFound(field, "orrery", named, sourceItems(field), hits);
  expect(found).toEqual([item("log/insertions/2026-10/ins_2.json", "Orrery repair estimate", "Oct 5")]);
});

test("an empty query finds nothing", () => {
  expect(searchFound(field, "  ", [], sourceItems(field), [item("x", "x")])).toEqual([]);
});
