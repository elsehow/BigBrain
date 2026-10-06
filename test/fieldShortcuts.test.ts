import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { keyLabel, pressed, SHORTCUTS, shortcutGroups, type ShortcutId } from "../web/ui/src/lib/v2/shortcuts";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("the handler asks the table for every key, and handles every key the table lists", () => {
  const src = readFileSync(new URL("../web/ui/src/components/V2View.svelte", import.meta.url), "utf8");
  const onKey = src.slice(src.indexOf("function onKey("), src.indexOf("function take("));
  // a raw e.key test is a shortcut the sheet doesn't know about — unless it
  // only tells apart the keys of one it does (j from k, ↑ from ↓)
  const raw = onKey.split("\n").filter((line) => /e\.key\s*===/.test(line) && !line.includes("pressed("));
  expect(raw).toEqual([]);
  for (const s of SHORTCUTS) expect(onKey).toContain(`pressed("${s.id}"`);
});

test("ids are unique and every shortcut reads as something", () => {
  expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  for (const s of SHORTCUTS) for (const b of s.keys) expect(keyLabel(b, true)).not.toBe("");
  expect(shortcutGroups().flatMap((g) => g.items)).toHaveLength(SHORTCUTS.length);
});

test("keys read the way they're pressed, per platform", () => {
  const label = (id: ShortcutId, mac: boolean) => SHORTCUTS.find((s) => s.id === id)!.keys.map((b) => keyLabel(b, mac));
  expect(label("new", true)).toEqual(["⌘N", "n"]);
  expect(label("new", false)).toEqual(["Ctrl+N", "n"]);
  expect(label("start", true)).toEqual(["⇧↵"]);
  expect(label("feed", true)).toEqual(["j k"]);
  expect(label("desktops", true)).toEqual(["1–9"]);
  expect(label("back", true)).toEqual(["Esc"]);
});

test("modifiers and shift decide which shortcut a press is", () => {
  expect(pressed("new", key("n"))).toBe(true);
  expect(pressed("new", key("N", { metaKey: true }))).toBe(true);
  expect(pressed("new", key("n", { ctrlKey: true }))).toBe(true);
  expect(pressed("new", key("N", { metaKey: true, shiftKey: true }))).toBe(false);
  expect(pressed("new", key("n", { metaKey: true, altKey: true }))).toBe(false);
  expect(pressed("search", key("/", { metaKey: true }))).toBe(false);
  expect(pressed("start", key("Enter", { shiftKey: true }))).toBe(true);
  expect(pressed("open", key("Enter", { shiftKey: true }))).toBe(false);
  expect(pressed("open", key("Enter"))).toBe(true);
  expect(pressed("shortcuts", key("?", { shiftKey: true }))).toBe(true);
  expect(pressed("desktops", key("7"))).toBe(true);
  expect(pressed("desktops", key("0"))).toBe(false);
});
