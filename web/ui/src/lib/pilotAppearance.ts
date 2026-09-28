import type { PilotViewData } from "./pilotChatSync";
import { isActivePilot } from "./pilotActivity";
import { pilotMessageCount } from "../../../../lib/pilotChatSummary";
import { SELECTOR_RATIO, type PilotChatPhase } from "../../../../lib/pilotChatTypes";

/** "unknown" is not a stored phase: it is what a record claiming "draft" while
 *  carrying history becomes, so the glyph never claims an answer it cannot see. */
export type PilotVisualPhase = PilotChatPhase | "idle" | "active" | "unknown";
export const TRIANGLE = [[0, 1], [Math.sqrt(3) / 2, -.5], [-Math.sqrt(3) / 2, -.5]] as const;
export const TRIANGLE_PATH = `M ${TRIANGLE.map(([x, y]) => `${x * 9} ${y * 9}`).join(" L ")} Z`;
export const pilotHollow = (phase: PilotVisualPhase) => ["draft", "working", "interrupted", "failed", "unknown"].includes(phase);

/** A draft is a conversation that has never sent anything: a session is born
 *  with an empty transcript (`newPilotChatSession`) and no transition returns to
 *  "draft". Transcript roles are only user/assistant — activity text, worker
 *  reports and ingestions live in other fields and are NOT sent user messages —
 *  so a transcript entry, or an accepted input, contradicts a stored "draft".
 *  Contradiction is all we know: which way the turn ended is unknowable from a
 *  record this inconsistent, so nothing here converts history into an answer. */
export function pilotDraftContradicted(s: Pick<PilotViewData, "phase"> & Partial<Pick<PilotViewData, "messages" | "messageCount" | "inputs">>): boolean {
  return s.phase === "draft" && (pilotMessageCount(s) > 0 || !!s.inputs?.length);
}
export const pilotVisualPhase = (s: Pick<PilotViewData, "phase" | "deactivatedAt"> & Partial<Pick<PilotViewData, "messages" | "messageCount" | "inputs">>): PilotVisualPhase =>
  !isActivePilot(s) ? "idle" : pilotDraftContradicted(s) ? "unknown" : s.phase;

export interface PilotStatusView { label: string; description: string }
/** One vocabulary for every list, row and tooltip. Words state what is known:
 *  an interrupted or failed turn is never "Ready", and an inconsistent record
 *  says so instead of borrowing a neighbouring phase's meaning. */
const PHASE_STATUS: Record<PilotVisualPhase, PilotStatusView> = {
  draft: { label: "Draft", description: "Draft — nothing sent yet" },
  working: { label: "Working", description: "Working — a turn is running" },
  answered: { label: "Ready", description: "Ready — the last turn finished" },
  interrupted: { label: "Interrupted", description: "Interrupted — the turn stopped before it finished" },
  failed: { label: "Needs attention", description: "Needs attention — the last turn ended in an error" },
  active: { label: "Needs you", description: "Needs you — this agent asked a question" },
  idle: { label: "Inactive", description: "Inactive — this conversation is closed" },
  unknown: { label: "Status unknown", description: "Status unknown — the saved status does not match this conversation's history" },
};
export const ARCHIVED_STATUS: PilotStatusView = { label: "Archived", description: "Archived — kept for reference" };
export function pilotStatusView(phase: PilotVisualPhase | undefined, { state, archived }: { state?: "waiting" | "running" | "idle"; archived?: boolean } = {}): PilotStatusView {
  if (archived) return ARCHIVED_STATUS;
  if (state === "waiting" || phase === "active") return PHASE_STATUS.active;
  if (state === "running" && (!phase || phase === "idle")) return PHASE_STATUS.working;
  return PHASE_STATUS[phase ?? "idle"];
}

/** Status marks inside the r=9 glyph, shared by NodeIndicator (SVG), the canvas
 *  and — copied literally, since GLSL cannot import — the graph shader.
 *  ORIENTATION carries the meaning because size does not: in the sidebar the
 *  whole triangle is about 9 device px wide, where the previous pair of 1.5-unit
 *  bars for "interrupted" left half a pixel of background between two 1.25px
 *  strokes and merged into the draft caret. One vertical stroke (draft, and it
 *  blinks), one horizontal bar (interrupted) and a cross (failed) stay apart. */
export type GlyphSegment = readonly [number, number, number, number];
export const PILOT_MARK_SEGMENTS: Readonly<Partial<Record<PilotVisualPhase, readonly GlyphSegment[]>>> = {
  draft: [[0, -3, 0, 4.5]],
  interrupted: [[-3.6, -1, 3.6, -1]],
  failed: [[-2.6, -3.5, 2.6, 1.6], [2.6, -3.5, -2.6, 1.6]],
};
export const pilotMarkPath = (phase: PilotVisualPhase): string =>
  (PILOT_MARK_SEGMENTS[phase] ?? []).map(([ax, ay, bx, by]) => `M ${ax} ${ay} L ${bx} ${by}`).join(" ");

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
  ctx.beginPath();
  if (phase !== "draft" || reducedMotion || now % 1000 < 500)
    for (const [ax, ay, bx, by] of PILOT_MARK_SEGMENTS[phase] ?? []) {
      ctx.moveTo(x + ax * r / 9, y + ay * r / 9); ctx.lineTo(x + bx * r / 9, y + by * r / 9);
    }
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
