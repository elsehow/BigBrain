/** Exact critically damped spring coefficients. Velocities are CSS units/ms.
 * Shared by CPU retargeting and the shader uniforms; no per-node frame loop. */
export const GRAPH_SETTLE_MS = 1000;
function dampedSpring(elapsed: number, rate: number, settle: number) {
  if (elapsed >= settle) return { position: 0, velocity: 0, positionRate: 0, velocityRate: 0 };
  const t = Math.max(0, elapsed), e = Math.exp(-rate * t);
  return { position: (1 + rate * t) * e, velocity: t * e,
    positionRate: -rate * rate * t * e, velocityRate: (1 - rate * t) * e };
}
export function graphSpring(elapsed: number) { return dampedSpring(elapsed, .014, GRAPH_SETTLE_MS); }

// Focus gets moving promptly, then glides through the final few percent.
// This is the prior spring shape, with a slightly faster response than wheel zoom.
export const GRAPH_FOCUS_MS = 650;
export function graphFocus(elapsed: number) { return dampedSpring(elapsed, .018, GRAPH_FOCUS_MS); }

/** A full sinusoidal velocity cycle, with a decaying tangent carrying the
 * incoming velocity through interruptions. Coefficients are evaluated once
 * per frame and shared by every GPU instance. */
export const GRAPH_SINE_MS = 700;
export function graphSine(elapsed: number, duration = GRAPH_SINE_MS) {
  if (elapsed >= duration) return { position: 0, velocity: 0, positionRate: 0, velocityRate: 0 };
  const t = Math.max(0, elapsed) / duration, angle = 2 * Math.PI * t;
  return { position: 1 - t + Math.sin(angle) / (2 * Math.PI),
    velocity: duration * (t - 6 * t ** 3 + 8 * t ** 4 - 3 * t ** 5),
    positionRate: -(1 - Math.cos(angle)) / duration,
    velocityRate: 1 - 18 * t ** 2 + 32 * t ** 3 - 15 * t ** 4 };
}

export interface GraphMotion {
  duration: number;
  sample: (elapsed: number) => ReturnType<typeof graphSine>;
}
export const FOCUS_MOTION: GraphMotion = { duration: GRAPH_FOCUS_MS, sample: graphFocus };
export const EXPLORE_MOTION: GraphMotion = { duration: GRAPH_SINE_MS, sample: graphSine };
