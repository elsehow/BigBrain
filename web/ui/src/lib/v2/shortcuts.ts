/**
 * shortcuts.ts — Field's keyboard shortcuts, written down once.
 *
 * V2View's key handler asks `pressed(id, e)` instead of testing `e.key`
 * itself, and the shortcuts sheet (`?`) renders this same table, so a key
 * the sheet lists is a key the view handles, and the reverse
 * (test/fieldShortcuts.test.ts holds the handler to it). The shortcuts ship
 * with the view; Settings keeps only whether the hints show.
 */

/** One way to press a shortcut. `mod` is ⌘ on a Mac and Ctrl elsewhere.
 * `shift` left out means either; `true`/`false` require it held / not held. */
export interface Binding { key: string | readonly string[]; mod?: boolean; shift?: boolean; label?: string }
export interface Shortcut { id: string; group: string; label: string; keys: readonly Binding[] }

const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export const SHORTCUTS = [
  { id: "search", group: "Field", label: "Search", keys: [{ key: "/" }] },
  { id: "feed", group: "Field", label: "Step through the feed", keys: [{ key: ["j", "k"] }] },
  { id: "open", group: "Field", label: "Open the selected row", keys: [{ key: "Enter", shift: false }] },
  { id: "start", group: "Field", label: "Start a Desktop on what’s open", keys: [{ key: "Enter", shift: true }] },
  { id: "desktops", group: "Field", label: "Open or close a Desktop", keys: [{ key: digits, label: "1–9" }] },
  { id: "new", group: "Field", label: "New Desktop", keys: [{ key: "n", mod: true, shift: false }, { key: "n" }] },
  { id: "views", group: "Field", label: "Show or hide the Desktop’s views", keys: [{ key: "\\" }] },
  { id: "original", group: "Field", label: "Open the original source", keys: [{ key: "o", mod: true, shift: false }] },
  { id: "back", group: "Field", label: "Back", keys: [{ key: "Escape" }] },
  { id: "settings", group: "Field", label: "Settings", keys: [{ key: ",", mod: true }] },
  { id: "shortcuts", group: "Field", label: "Shortcuts", keys: [{ key: "?" }] },
  { id: "search-move", group: "Search", label: "Move through results", keys: [{ key: ["ArrowUp", "ArrowDown"] }] },
  { id: "search-open", group: "Search", label: "Open the result", keys: [{ key: "Enter", shift: false }] },
  { id: "search-start", group: "Search", label: "Start a Desktop on the result", keys: [{ key: "Enter", shift: true }] },
  { id: "search-close", group: "Search", label: "Close search", keys: [{ key: "Escape" }] },
  { id: "composer-leave", group: "Desktop", label: "Leave the message box", keys: [{ key: "Escape" }] },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];
const byId = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

type Press = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;
function matches(b: Binding, e: Press): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (mod !== !!b.mod || (b.mod && e.altKey)) return false;
  if (b.shift !== undefined && e.shiftKey !== b.shift) return false;
  const keys: readonly string[] = typeof b.key === "string" ? [b.key] : b.key;
  // ⌘N arrives as "N" with caps lock on
  return keys.includes(b.mod ? e.key.toLowerCase() : e.key);
}

/** Did this keydown press the shortcut `id`? */
export function pressed(id: ShortcutId, e: Press): boolean {
  return byId.get(id)!.keys.some((b) => matches(b, e));
}

const NAMES: Record<string, string> = { Enter: "↵", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓" };
/** How a binding reads on screen: "⌘N", "⇧↵", "j k", "1–9". */
export function keyLabel(b: Binding, mac: boolean): string {
  const keys: readonly string[] = typeof b.key === "string" ? [b.key] : b.key;
  const name = b.label ?? keys.map((k) => NAMES[k] ?? (b.mod ? k.toUpperCase() : k)).join(" ");
  return (b.mod ? (mac ? "⌘" : "Ctrl+") : "") + (b.shift ? "⇧" : "") + name;
}

/** The table in its groups, in order, for the sheet. */
export function shortcutGroups(): Array<{ group: string; items: Shortcut[] }> {
  const out: Array<{ group: string; items: Shortcut[] }> = [];
  for (const s of SHORTCUTS) {
    const g = out.find((x) => x.group === s.group) ?? out[out.push({ group: s.group, items: [] }) - 1]!;
    g.items.push(s);
  }
  return out;
}
