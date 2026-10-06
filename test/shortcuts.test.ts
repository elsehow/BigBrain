import { expect, test } from "bun:test";
import { dispatch, keyLabel, matches, RANK, shortcutGroups, type Scope } from "../web/ui/src/lib/shortcutKeys";

type Mods = Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>;
// a keydown as the dispatcher sees it; `target` stands in for the focused element
const press = (key: string, mods: Mods = {}, target: unknown = null) => {
  const e = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, target, ...mods,
    preventDefault() { e.defaultPrevented = true; }, stopPropagation() {} };
  return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
};
// an element that contains itself and the listed children
const el = (tagName = "DIV", kids: unknown[] = [], isContentEditable = false): Element => {
  const self = { tagName, isContentEditable, contains: (n: unknown) => n === self || kids.includes(n) };
  return self as unknown as Element;
};
const scope = (title: string, rank: number, ids: Record<string, string>, log: string[], extra: Partial<Scope> = {}): Scope =>
  ({ title, rank, ...extra, shortcuts: Object.entries(ids).map(([id, key]) => ({ id, label: id, keys: [{ key }], run: () => { log.push(id); } })) });

test("matching: modifiers and shift decide which binding a press is", () => {
  expect(matches({ key: "n" }, press("n"))).toBe(true);
  expect(matches({ key: "n", mod: true, shift: false }, press("N", { metaKey: true }))).toBe(true);
  expect(matches({ key: "n", mod: true, shift: false }, press("n", { ctrlKey: true }))).toBe(true);
  expect(matches({ key: "n", mod: true, shift: false }, press("N", { metaKey: true, shiftKey: true }))).toBe(false);
  expect(matches({ key: "n" }, press("n", { metaKey: true }))).toBe(false);
  expect(matches({ key: "n" }, press("n", { altKey: true }))).toBe(false);
  expect(matches({ key: "Enter", shift: true }, press("Enter"))).toBe(false);
  expect(matches({ key: "?" }, press("?", { shiftKey: true }))).toBe(true);
});

test("keys read the way they're pressed, per platform", () => {
  expect(keyLabel({ key: "n", mod: true }, true)).toBe("⌘N");
  expect(keyLabel({ key: "n", mod: true }, false)).toBe("Ctrl+N");
  expect(keyLabel({ key: "Enter", shift: true }, true)).toBe("⇧↵");
  expect(keyLabel({ key: ["j", "k"] }, true)).toBe("j k");
  expect(keyLabel({ key: ["1", "2"], label: "1–9" }, true)).toBe("1–9");
  expect(keyLabel({ key: "Escape" }, true)).toBe("Esc");
});

test("higher rank answers first; among equals, the latest registered", () => {
  const log: string[] = [];
  const list = [scope("Field", RANK.field, { low: "x" }, log), scope("A", RANK.panel, { first: "x" }, log), scope("B", RANK.panel, { second: "x" }, log)];
  const e = press("x");
  expect(dispatch(e, list, null)).toBe(true);
  expect(log).toEqual(["second"]);
  expect(e.defaultPrevented).toBe(true);
});

test("a shortcut that declines, or doesn't apply, lets the key fall through", () => {
  const log: string[] = [];
  const top: Scope = { title: "Top", rank: RANK.panel, shortcuts: [
    { id: "declines", label: "", keys: [{ key: "x" }], run: () => false },
    { id: "inapplicable", label: "", keys: [{ key: "x" }], when: () => false, run: () => { log.push("inapplicable"); } },
  ] };
  expect(dispatch(press("x"), [scope("Field", RANK.field, { field: "x" }, log), top], null)).toBe(true);
  expect(log).toEqual(["field"]);
  expect(dispatch(press("y"), [top], null)).toBe(false);
});

test("a plain key typed into a text field is a letter, unless the scope owns that field", () => {
  const log: string[] = [];
  const box = el("INPUT");
  const field = scope("Field", RANK.field, { feed: "j", back: "Escape" }, log);
  const search = scope("Search", RANK.input, { "search-close": "Escape" }, log, { input: () => box });
  const mod: Scope = { title: "Field", rank: RANK.field, shortcuts: [{ id: "new", label: "", keys: [{ key: "n", mod: true }], run: () => { log.push("new"); } }] };
  expect(dispatch(press("j", {}, box), [field], null)).toBe(false);
  expect(dispatch(press("Escape", {}, box), [field, search], null)).toBe(true);
  expect(dispatch(press("n", { metaKey: true }, box), [mod], null)).toBe(true);
  // an owned field answers only for keys typed into it
  expect(dispatch(press("Escape", {}, el()), [search], null)).toBe(false);
  expect(log).toEqual(["search-close", "new"]);
});

test("`typing` lets a plain key through from any text field", () => {
  const log: string[] = [];
  const settings: Scope = { title: "Settings", rank: RANK.panel, shortcuts: [{ id: "settings-close", label: "", keys: [{ key: "Escape", typing: true }], run: () => { log.push("close"); } }] };
  expect(dispatch(press("Escape", {}, el("TEXTAREA")), [settings], null)).toBe(true);
  expect(log).toEqual(["close"]);
});

test("while a modal dialog is open, only its own scopes answer", () => {
  const log: string[] = [];
  const sheet = el("DIALOG");
  const list = [scope("Field", RANK.field, { search: "/", shortcuts: "?" }, log), scope("Shortcuts", RANK.modal, { "shortcuts-close": "?" }, log, { root: () => sheet })];
  expect(dispatch(press("/"), list, sheet)).toBe(false);
  expect(dispatch(press("?"), list, sheet)).toBe(true);
  expect(dispatch(press("?"), list.slice(0, 1), null)).toBe(true);
  expect(log).toEqual(["shortcuts-close", "shortcuts"]);
});

test("a key something else already took, or one mid-composition, is left alone", () => {
  const log: string[] = [];
  const list = [scope("Field", RANK.field, { search: "/" }, log)];
  expect(dispatch(press("/", {}, null), list, null)).toBe(true);
  const taken = press("/"); taken.preventDefault();
  expect(dispatch(taken, list, null)).toBe(false);
  expect(dispatch({ ...press("/"), isComposing: true } as KeyboardEvent, list, null)).toBe(false);
  expect(log).toEqual(["search"]);
});

test("the sheet lists scopes lowest rank first, merged by title, each shortcut once", () => {
  const log: string[] = [];
  const groups = shortcutGroups([
    scope("Message box", RANK.input, { send: "Enter" }, log),
    scope("Field", RANK.field, { search: "/" }, log),
    scope("Message box", RANK.input, { leave: "Escape", send: "Enter" }, log),
    scope("Empty", RANK.panel, {}, log),
  ]);
  expect(groups.map((g) => [g.title, g.items.map((s) => s.id)])).toEqual([["Field", ["search"]], ["Message box", ["send", "leave"]]]);
});
