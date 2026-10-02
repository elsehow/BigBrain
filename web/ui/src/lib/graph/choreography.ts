const reveal = (elapsed: number, start: number, end: number) => {
  const t = Math.max(0, Math.min(1, (elapsed - start) / (end - start)));
  return t * t * (3 - 2 * t);
};
export const CHOREOGRAPHY_MS = 560;
export function graphChoreography(elapsed: number, reduced = false) {
  return reduced ? { departing: 0, edges: 1, labels: 1 } : {
    departing: 1 - reveal(elapsed, 0, 130),
    edges: reveal(elapsed, 170, 450),
    labels: reveal(elapsed, 360, CHOREOGRAPHY_MS),
  };
}
