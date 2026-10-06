/**
 * shortcutKeys.ts — the keyboard's arithmetic, without the runes: what a
 * shortcut is, whether a keydown presses it, which registered scope answers,
 * and how keys read. The live registry is shortcuts.svelte.ts.
 */
import { editable, isMac } from "./dom";

/** One way to press a shortcut. `mod` is ⌘ on a Mac and Ctrl elsewhere.
 * `shift` left out means either; `true`/`false` require it held / not held.
 * A plain key is skipped while a text field has the keyboard (it's a letter
 * someone is typing) unless `typing` says otherwise or the scope owns that
 * field; a `mod` key always counts. `label` overrides how it reads ("1–9"). */
export interface Binding { key: string | readonly string[]; mod?: boolean; shift?: boolean; typing?: boolean; label?: string }

export interface Shortcut {
  id: string;
  label: string;
  keys: readonly Binding[];
  /** Whether it applies right now; the key falls through when it doesn't. */
  when?: () => boolean;
  /** Return false to decline after all — the key falls through. */
  run: (e: KeyboardEvent) => void | boolean;
}

export interface Scope {
  /** The sheet's heading for these. */
  title: string;
  /** Higher ranks answer first; among equals, the latest registered. */
  rank: number;
  shortcuts: readonly Shortcut[];
  when?: () => boolean;
  /** A text field this scope owns: it answers only for keys typed into it,
   * plain keys included. */
  input?: () => Element | null | undefined;
  /** The modal dialog this scope belongs to. While a modal is open, only its
   * own scopes answer. */
  root?: () => Element | null | undefined;
}

export const RANK = { field: 10, input: 20, popup: 25, panel: 30, modal: 40 } as const;

type Press = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;
export function matches(b: Binding, e: Press): boolean {
  if (e.altKey || (e.metaKey || e.ctrlKey) !== !!b.mod) return false;
  if (b.shift !== undefined && e.shiftKey !== b.shift) return false;
  const keys: readonly string[] = typeof b.key === "string" ? [b.key] : b.key;
  // ⌘N arrives as "N" with caps lock on
  return keys.includes(b.mod ? e.key.toLowerCase() : e.key);
}

function openModal(): Element | null {
  if (typeof document === "undefined") return null;
  try { return document.querySelector("dialog:modal"); } catch { return document.querySelector("dialog[open]"); }
}

/** Hand a keydown to these scopes. True when one took it. */
export function dispatch(e: KeyboardEvent, list: readonly Scope[], modal: Element | null = openModal()): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const target = (e.target ?? null) as Node | null;
  const typing = editable(e.target);
  const ordered = list.map((s, i) => ({ s, i })).sort((a, b) => b.s.rank - a.s.rank || b.i - a.i);
  for (const { s } of ordered) {
    if (s.when && !s.when()) continue;
    if (modal) { const root = s.root?.(); if (!root || !modal.contains(root)) continue; }
    const owned = s.input?.();
    if (s.input && !(owned && target && owned.contains(target))) continue;
    for (const sc of s.shortcuts) {
      if (!sc.keys.some((b) => matches(b, e) && (!typing || s.input || b.mod || b.typing))) continue;
      if (sc.when && !sc.when()) continue;
      if (sc.run(e) === false) continue;
      e.preventDefault(); e.stopPropagation();
      return true;
    }
  }
  return false;
}

const mac = typeof navigator !== "undefined" && isMac();
const NAMES: Record<string, string> = { Enter: "↵", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", Tab: "Tab", Home: "Home", End: "End" };
/** How a binding reads on screen: "⌘N", "⇧↵", "j k", "1–9". */
export function keyLabel(b: Binding, onMac = mac): string {
  const keys: readonly string[] = typeof b.key === "string" ? [b.key] : b.key;
  const name = b.label ?? keys.map((k) => NAMES[k] ?? (b.mod ? k.toUpperCase() : k)).join(" ");
  return (b.mod ? (onMac ? "⌘" : "Ctrl+") : "") + (b.shift ? "⇧" : "") + name;
}

/** The sheet: registered scopes by title, lowest rank first, each shortcut
 * once (a component mounted twice registers its keys twice). */
export function shortcutGroups(list: readonly Scope[]): Array<{ title: string; items: Shortcut[] }> {
  const out: Array<{ title: string; items: Shortcut[] }> = [];
  const seen = new Set<string>();
  for (const s of [...list].sort((a, b) => a.rank - b.rank)) {
    let g = out.find((x) => x.title === s.title);
    if (!g) out.push(g = { title: s.title, items: [] });
    for (const sc of s.shortcuts) if (!seen.has(sc.id)) { seen.add(sc.id); g.items.push(sc); }
  }
  return out.filter((g) => g.items.length);
}
