// cursor.svelte.ts — which input device currently OWNS row selection.
//
// The UI's invariant: at most ONE row is selected (well highlight +
// revealed actions) at any moment, across every list. Hover and the
// keyboard cursor are different ideas and must never both paint:
// - a real mousemove hands selection to the mouse (hover paints, the
//   keyboard cursor drops to a subtle location marker — for as long as a
//   row is actually under the pointer: the keyboard cursor stays painted,
//   and lit in the graph, while the pointer is off the rows altogether,
//   so a selection can be explored from — 2026-09-06),
// - any handled list-nav key hands it back (hover stops painting even
//   if a row sits under the pointer — keyboard scrolling routinely
//   parks rows there without the mouse moving).
// The keyboard cursor's POSITION survives mouse interludes untouched;
// the marker is what lets j/k resume without a guess.
//
// App.svelte mirrors the mode onto <body> as `kbd-nav`. Every list in the
// text tab has to SAY which row is current — the row's node is lit in the
// graph and the camera flies to it — so each reads `cursor.input` in
// script and derives one `current` index (lib/listNav.ts's currentRow)
// that paints and lights alike, with no :hover rule.
export const cursor = $state({ input: "mouse" as "mouse" | "kbd" });

/** Call from a list keynav handler when it actually handles a key. */
export function kbdTakes(): void {
  if (cursor.input !== "kbd") cursor.input = "kbd";
}

/** Call on real mousemove only — never mouseenter, which also fires when
 * keyboard-driven scrolling slides a row under a stationary pointer. */
export function mouseTakes(): void {
  if (cursor.input !== "mouse") cursor.input = "mouse";
}
