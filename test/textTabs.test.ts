import { expect, test } from "bun:test";
import { textTabKey, visibleTextTabs } from "../web/ui/src/lib/textTabs";
const key = (k: string, extra = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, ...extra });
test("Tab cycles all three views from fields too; Shift reverses and wraps", () => {
  expect(textTabKey(key("Tab"), "recent", true)).toBe("top");
  expect(textTabKey(key("Tab"), "top", false)).toBe("pilot");
  expect(textTabKey(key("Tab"), "pilot", false)).toBe("recent");
  expect(textTabKey(key("Tab", { shiftKey: true }), "recent", false)).toBe("pilot");
});
test("letter shortcuts preserve typing, IME, platform chords and key repeats", () => {
  for (const [k, tab] of [["r", "recent"], ["t", "top"], ["p", "pilot"]]) {
    expect(textTabKey(key(k!), "recent", false)).toBe(tab);
    expect(textTabKey(key(k!), "recent", true)).toBeNull();
  }
  for (const option of ["ctrlKey", "metaKey", "altKey", "repeat", "isComposing"]) {
    expect(textTabKey(key("Tab", { [option]: true }), "recent", false)).toBeNull();
    expect(textTabKey(key("t", { [option]: true }), "recent", false)).toBeNull();
  }
});

test("disabled Pilot is hidden from keyboard cycling and its letter shortcut", () => {
  expect(textTabKey(key("Tab"), "recent", false, false)).toBe("top");
  expect(textTabKey(key("Tab"), "top", false, false)).toBe("recent");
  expect(textTabKey(key("Tab", { shiftKey: true }), "recent", false, false)).toBe("top");
  expect(textTabKey(key("p"), "recent", false, false)).toBeNull();
});

test("an open note is the last tab and participates in both directions of navigation", () => {
  const title = "A selected note with a long title";
  expect(visibleTextTabs(true, title).map(t => t.id)).toEqual(["recent", "top", "pilot", "note"]);
  expect(visibleTextTabs(true, title).at(-1)).toEqual({ id: "note", label: title, key: "o" });
  expect(textTabKey(key("o"), "recent", false, true, title)).toBe("note");
  expect(textTabKey(key("o"), "pilot", false, true, title)).toBe("note");
  expect(textTabKey(key("o"), "recent", true, true, title)).toBeNull();
  expect(textTabKey(key("o", { metaKey: true }), "recent", false, true, title)).toBeNull();
  expect(textTabKey(key("o"), "recent", false)).toBeNull();
  expect(textTabKey(key("Tab"), "pilot", false, true, title)).toBe("note");
  expect(textTabKey(key("Tab"), "note", false, true, title)).toBe("recent");
  expect(textTabKey(key("Tab", { shiftKey: true }), "recent", false, true, title)).toBe("note");
  expect(textTabKey(key("Tab"), "top", false, false, title)).toBe("note");
  expect(textTabKey(key("Tab", { shiftKey: true }), "note", false, false, title)).toBe("top");
  // Escape closes a note via the route handler; it never selects the note tab.
  expect(textTabKey(key("Escape"), "note", false, true, title)).toBeNull();
  expect(visibleTextTabs(false).map(t => t.id)).toEqual(["recent", "top"]);
});
