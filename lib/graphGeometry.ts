/**
 * graphGeometry.ts — the two numbers the layout and the renderer must agree
 * on, in the one place both can import.
 *
 * A node's RADIUS is a rendering property that the layout depends on: the
 * collide force keeps discs from overlapping, so its spacing is built on
 * the radius the canvas will actually draw. While the simulation ran in
 * the browser these lived together in LinkGraph.svelte and could not
 * disagree. Now that the layout is computed server-side
 * (lib/graphLayout.ts) they are on opposite sides of the wire, and a copy
 * on each side would drift the first time someone restyled a node —
 * silently, because the picture would still look plausible, just packed
 * wrong.
 *
 * Kept free of `node:` imports on purpose: the viewer bundle imports this
 * directly (web/ui/src/components/LinkGraph.svelte), the same way it already
 * imports lib/slug.ts and lib/viewTypes.ts.
 */

/** The biggest disc drawn: the cap on nodeRadius, and how far the canvas's
 * hit-test reaches around the pointer. */
export const NODE_R_MAX = 8;

/** Disc radius for a node of this degree — hubs bigger, capped so one
 * enormous hub cannot swallow the canvas. Points, not discs (2026-09-05):
 * a leaf is a 2px pinprick and a hub of hundreds an 8px star, so a
 * whole-vault view is threads with nodes at their junctions rather than a
 * mass of discs hiding the threads. It was 4 + √degree × 1.4 capped at 18,
 * sized when the picture was a few hundred notes; at sixteen hundred the
 * core fused into one white mass. */
export const nodeRadius = (degree: number): number => Math.min(NODE_R_MAX, 1.5 + Math.sqrt(degree) * 0.55);

/** The layout's collision radius for a node of this degree: the drawn disc
 * plus breathing room. The room is what keeps a whole-vault view from
 * fusing — a leaf settles no closer to its neighbour than it did when the
 * discs were bigger (4 + √degree × 1.4, plus the force's own 2) — and it
 * lives beside nodeRadius so a restyle of the disc cannot silently repack
 * the vault. */
export const nodeSpacing = (degree: number): number => nodeRadius(degree) + 5.5;

/** The golden angle: a phyllotaxis (sunflower) spiral spreads a cold start
 * evenly instead of piling every node on the origin, where the charge force
 * would explode. */
export const GOLDEN = 2.399963229728653;

/** Starting position for the i-th node when nothing better is known. */
export function seedPosition(i: number): [number, number] {
  const r = 12 * Math.sqrt(i + 0.5);
  const a = i * GOLDEN;
  return [Math.cos(a) * r, Math.sin(a) * r];
}
