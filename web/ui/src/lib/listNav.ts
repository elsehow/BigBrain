/**
 * listNav.ts — the arithmetic a keyboard list cursor needs.
 *
 * Classic's lists (the feed, search, the palette, the notification stack)
 * shared more here — navDelta, clamped, currentRow, gg/G — and went with
 * Classic (#100, #129). The @ menu's walk is what's left.
 */

/** One step, clamped to the list.
 *
 * The top clamp is 0, not -1: "nothing selected" is a state you arrive at
 * by Escape or by an empty list, never by walking up off the first row —
 * a k that quietly deselected would read as the list losing your place. */
export function stepped(sel: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return sel;
  return delta > 0 ? Math.min(sel + 1, count - 1) : Math.max(sel - 1, 0);
}
