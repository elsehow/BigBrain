import type { WorkDetail } from "../../../../lib/workViews";
export const AGENT_STATES = ["running", "waiting", "done", "stopped"] as const;
export type AgentVisualState = typeof AGENT_STATES[number];
export function agentVisualState(s: Pick<WorkDetail, "status" | "external" | "worker">): AgentVisualState {
  if (s.worker?.archivedAt || s.external?.archivedAt) return "stopped";
  return s.status === "working" || s.status === "starting" ? "running" : s.status === "needs-input" ? "waiting"
    : s.status === "idle" ? "done" : "stopped";
}
/** Shared geometry for SVG and canvas. A finished turn is still a live,
 * resumable agent; only stopped workers settle into vault ink. */
export function agentGlyph(state: AgentVisualState, selected = false) {
  return { active: state !== "stopped", live: state === "running" || state === "waiting", outer: state === "running" || selected,
    outerRadius: 12, innerRadius: 6, inverted: selected && state === "running",
    spin: state === "running", pulse: state === "waiting", periodMs: 2400 };
}
export function drawAgentIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number,
  state: AgentVisualState, selected: boolean, now: number, reduced: boolean, ink: string, bg: string, accent: string): void {
  const g = agentGlyph(state, selected), color = g.active ? accent : ink;
  ctx.save(); ctx.translate(x, y); ctx.lineWidth = 1.25; ctx.setLineDash([]); ctx.globalAlpha = 1;
  ctx.strokeStyle = ctx.fillStyle = color;
  if (g.outer) {
    ctx.save(); if (g.spin && !reduced) ctx.rotate(now / g.periodMs * Math.PI * 2);
    const r = g.outerRadius * scale;
    if (g.inverted) ctx.fillRect(-r, -r, r * 2, r * 2); else ctx.strokeRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
  if (g.pulse && !reduced) ctx.globalAlpha = .675 + .325 * Math.cos(now / 1400 * Math.PI * 2);
  ctx.fillStyle = g.inverted ? bg : color;
  const r = g.innerRadius * scale; ctx.fillRect(-r, -r, r * 2, r * 2); ctx.restore();
}
