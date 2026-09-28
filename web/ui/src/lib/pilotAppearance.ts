import type { PilotViewData } from "./pilotChatSync";
import { isActivePilot } from "./pilotActivity";
import { SELECTOR_RATIO, type PilotChatPhase } from "../../../../lib/pilotChatTypes";

export type PilotVisualPhase = PilotChatPhase | "idle" | "active";
export const TRIANGLE = [[0, 1], [Math.sqrt(3) / 2, -.5], [-Math.sqrt(3) / 2, -.5]] as const;
export const TRIANGLE_PATH = `M ${TRIANGLE.map(([x, y]) => `${x * 9} ${y * 9}`).join(" L ")} Z`;
export const pilotHollow = (phase: PilotVisualPhase) => ["draft", "working", "interrupted", "failed"].includes(phase);
export const pilotVisualPhase = (s: Pick<PilotViewData, "phase" | "deactivatedAt">): PilotVisualPhase =>
  isActivePilot(s) ? s.phase : "idle";
/** Boundary along a unit ray, measured in triangle circumradii. */
export function pilotTriangleRadius(ux: number, uy: number): number {
  return Math.min(...[[Math.sqrt(3) * ux + uy, 1], [-Math.sqrt(3) * ux + uy, 1], [-uy, .5]]
    .filter(([direction]) => direction > 0).map(([direction, distance]) => distance / direction));
}

/** Canvas counterpart of NodeIndicator, using the same shape and phase rules. */
export function drawPilotIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  phase: PilotVisualPhase, selected: boolean, now: number, reducedMotion: boolean, ink: string, bg: string, accent: string, ratio = SELECTOR_RATIO, opacity = 1): void {
  ctx.save(); ctx.globalAlpha = opacity; ctx.lineWidth = 1.25; ctx.strokeStyle = ctx.fillStyle = phase === "idle" ? ink : accent;
  ctx.setLineDash([]); ctx.lineDashOffset = 0;
  if (selected) { ctx.globalAlpha = .6 * opacity; ctx.beginPath(); ctx.arc(x, y, r * ratio, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = opacity; }
  if (phase === "working") {
    const angle = reducedMotion ? 0 : now / 1000 * Math.PI * 2;
    ctx.beginPath(); ctx.arc(x, y, r * ratio, angle, angle + Math.PI * .52); ctx.stroke();
  }
  ctx.beginPath(); TRIANGLE.forEach(([px, py], i) => i ? ctx.lineTo(x + px * r, y + py * r) : ctx.moveTo(x + px * r, y + py * r)); ctx.closePath();
  ctx.fillStyle = pilotHollow(phase) ? bg : ctx.strokeStyle; ctx.fill(); ctx.lineJoin = "round"; ctx.stroke();
  const mark = (ax: number, ay: number, bx: number, by: number) => { ctx.moveTo(x + ax * r / 9, y + ay * r / 9); ctx.lineTo(x + bx * r / 9, y + by * r / 9); };
  ctx.beginPath();
  if (phase === "draft" && (reducedMotion || now % 1000 < 500)) mark(0, -2, 0, 3.5);
  if (phase === "interrupted") { mark(-1.5, -2, -1.5, 2); mark(1.5, -2, 1.5, 2); }
  if (phase === "failed") { mark(0, -2, 0, 0); mark(0, 1.5, 0, 2.5); }
  ctx.stroke(); ctx.restore();
}

/** Static bracket geometry; the graph overlay owns composited opacity animation. */
export function drawAttentionSelector(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    ctx.moveTo(x + sx * r / 2, y + sy * r); ctx.lineTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * r, y + sy * r / 2);
  }
  ctx.stroke(); ctx.restore();
}
