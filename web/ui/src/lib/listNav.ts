/**
 * listNav.ts — the arithmetic every list keyboard shares.
 *
 * Four surfaces walk a selection with the same keys: the arrivals feed
 * (RecentTab), the search results — from the list (SearchTab) and from
 * inside the field (TopBar) — and the recent palette. Each had the two
 * clamps written out by hand, four times (#643).
 *
 * The POLICY stays with each list, because it genuinely differs and a
 * helper that took all of it would need a knob per caller: which view owns
 * the keyboard, whether a modifier disqualifies the key, what Enter opens,
 * and what Escape does (clear the selection / leave the search / back out
 * of the field and then close the card — three different answers). Only
 * the parts that are the same on all four live here.
 */

/** Which way a keydown moves a list cursor, or null if it moves nothing.
 *
 * `letters` is whether j/k count. They do not while a text field has the
 * keyboard — there they are letters someone is typing — which is why
 * TopBar passes false and the palette passes "is the target editable". */
export function navDelta(e: KeyboardEvent, letters = true): -1 | 1 | null {
  if (e.key === "ArrowDown" || (letters && e.key === "j")) return 1;
  if (e.key === "ArrowUp" || (letters && e.key === "k")) return -1;
  return null;
}

/** One step, clamped to the list.
 *
 * The top clamp is 0, not -1: "nothing selected" is a state you arrive at
 * by Escape or by an empty list, never by walking up off the first row —
 * a k that quietly deselected would read as the list losing your place. */
export function stepped(sel: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return sel;
  return delta > 0 ? Math.min(sel + 1, count - 1) : Math.max(sel - 1, 0);
}

/** Where the cursor holds when the list shrinks under it: the last row
 * that still exists, or `rest` once there are none. `rest` is the caller's,
 * because the two lists disagree about what "no selection" is — the feed
 * parks at -1 (nothing highlighted), the palette at 0 (a row is always
 * current, so ↵ always has something to open). */
export function clamped(sel: number, count: number, rest: number): number {
  if (sel < count) return sel;
  return count ? count - 1 : rest;
}

/** Which row is CURRENT — painted, lit in the graph, the camera on it —
 * given who owns selection (lib/cursor.svelte.ts), the row under the
 * pointer and the keyboard cursor's row. The row under the pointer while
 * the mouse owns selection AND is on one; the keyboard cursor's otherwise.
 *
 * "And is on one" is what lets a keyboard selection HOLD while the pointer
 * roams the graph (Nick, 2026-09-06: "once I've selected something with
 * the keyboard, mouse around and see what's connected to it"): the light
 * and the camera stay on it, and a row under the pointer is a preview the
 * camera visits and comes back from. It used to be the mouse's the moment
 * it moved, and the first twitch flew the camera home. One rule for every
 * list in the text tab, so the mouse and the keyboard cannot drift apart
 * (0.1.30 lit the graph from the cursor alone while the well followed
 * :hover — Nick, 2026-09-03: "smells like spaghetti"). */
export function currentRow(input: "mouse" | "kbd", hover: number, sel: number): number {
  return input === "mouse" && hover >= 0 ? hover : sel;
}

/** Vim-style endpoints without stealing letters from text inputs. */
export function createListJump() {
  let previousG = 0;
  return (e: Pick<KeyboardEvent, "key" | "repeat">, letters = true): "first" | "last" | "pending" | null => {
    const now = Date.now();
    if (e.key === "g" && letters && !e.repeat) {
      if (previousG && now - previousG < 700) { previousG = 0; return "first"; }
      previousG = now; return "pending";
    }
    previousG = 0;
    return e.key === "Home" ? "first" : e.key === "End" || letters && e.key === "G" ? "last" : null;
  };
}
