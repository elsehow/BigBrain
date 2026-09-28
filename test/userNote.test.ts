import { expect, test } from "bun:test";
import { isUserNote, isUserNode } from "../web/ui/src/lib/userNote";

const id = "ent_0123456789abcdef0123";
const user = { ids: [id], names: ["Alex Rowan", "demo-user", "Élodie"] };

test("owner links match native ids, projected paths, and exact legacy names", () => {
  for (const target of [id, `projection/entities/${id}`, `projection/entities/${id}.md#History`, "Alex Rowan", "alex-rowan", "entities/alex-rowan.md", "demo-user", "ÉLODIE"])
    expect(isUserNote(target, user)).toBe(true);
});

test("other people and similarly titled source notes remain navigable", () => {
  for (const target of ["Alex", "Alex Rowan project", "Alex Smith", "references/alex-rowan.md", "memory/alex-rowan", "ent_ffffffffffffffffffff"])
    expect(isUserNote(target, user)).toBe(false);
  expect(isUserNote("Alex Rowan")).toBe(false);
  expect(isUserNote("Alex Rowan", { ids: [], names: ["Ada Lovelace"] })).toBe(false);
});


test("owner suppression includes the named memory index, without hiding sources or similarly named people", () => {
  expect(isUserNode({ id, title: "Alex Rowan", path: `projection/entities/${id}.md` }, user)).toBe(true);
  expect(isUserNode({ id: "memory/MEMORY.md", title: "Alex Rowan", path: "memory/MEMORY.md" }, user)).toBe(true);
  expect(isUserNode({ id: "source:x", title: "Alex Rowan", path: "log/insertions/x.json" }, user)).toBe(false);
  expect(isUserNode({ id: "ent_other", title: "Alex Smith", path: "projection/entities/ent_other.md" }, user)).toBe(false);
  expect(isUserNode({ id: "memory/MEMORY.md", title: "Vault index", path: "memory/MEMORY.md" }, user)).toBe(false);
});
