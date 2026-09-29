/**
 * The sidebar draws a 28px glyph whose triangle is about 9 device pixels wide,
 * so "which status is this?" is decided by a few pixels of mark. These tests
 * MEASURE that mark at the size it actually ships at, keep the three renderers
 * (SVG, canvas, shader codes) saying the same thing, and hold the one rule the
 * words must obey: Draft belongs to a conversation that has never sent a user
 * message, and a record that contradicts its own phase says so rather than
 * claiming an answer. Fabricated sessions only.
 */
import { test, expect } from "bun:test";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import {
  PILOT_MARK_SEGMENTS, drawPilotIndicator, pilotDraftContradicted, pilotHollow, pilotMarkPath,
  pilotStatusView, pilotTriangleRadius, pilotVisualPhase, type GlyphSegment, type PilotVisualPhase,
} from "../web/ui/src/lib/pilotAppearance";
import { pilotRoster, rosterStatusView } from "../web/ui/src/lib/pilotAttention";
import { phaseCode } from "../web/ui/src/lib/graph/status";

const PHASES: PilotVisualPhase[] = ["idle", "active", "draft", "working", "interrupted", "failed", "answered", "unknown"];
const MARKED: PilotVisualPhase[] = ["draft", "interrupted", "failed"];
/** The sidebar row: NodeIndicator's 48-unit viewBox drawn at 28 CSS px, with a
 *  non-scaling 1.25px stroke — the geometry the screenshot complaint was about. */
const SIZE = 28, UNIT = SIZE / 48, STROKE = 1.25;
const segments = (phase: PilotVisualPhase): readonly GlyphSegment[] => PILOT_MARK_SEGMENTS[phase] ?? [];
const lengthPx = ([ax, ay, bx, by]: GlyphSegment) => Math.hypot(bx - ax, by - ay) * UNIT;
/** Undirected orientation in degrees: a stroke and its reverse are one line. */
const orientation = ([ax, ay, bx, by]: GlyphSegment) => (Math.atan2(by - ay, bx - ax) * 180 / Math.PI + 180) % 180;
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));
/** Background left between the closest pair of parallel strokes, in device px. */
function parallelGapPx(marks: readonly GlyphSegment[]): number {
  let gap = Infinity;
  for (const a of marks) for (const b of marks) {
    if (a === b || apart(orientation(a), orientation(b)) > 1) continue;
    const [ax, ay, bx, by] = a, angle = Math.atan2(by - ay, bx - ax);
    const distance = Math.abs((b[0] - ax) * -Math.sin(angle) + (b[1] - ay) * Math.cos(angle)) * UNIT;
    gap = Math.min(gap, distance - STROKE);
  }
  return gap;
}

test("draft, interrupted and failed are told apart by orientation at the sidebar's 28px glyph", () => {
  for (const phase of MARKED) {
    expect(segments(phase).length).toBeGreaterThan(0);
    for (const segment of segments(phase)) expect(lengthPx(segment)).toBeGreaterThanOrEqual(2.5);
  }
  const angles = Object.fromEntries(MARKED.map(phase => [phase, segments(phase).map(orientation)]));
  expect(angles["draft"]).toEqual([90]);
  expect(angles["interrupted"]).toEqual([0]);
  expect(angles["failed"]!.map(Math.round).sort((a, b) => a - b)).toEqual([44, 136]);
  // Two marks that differ only in length are a coin toss at this size; every
  // pair of phases must differ in the direction its ink runs.
  for (const a of MARKED) for (const b of MARKED) {
    if (a === b) continue;
    const separation = Math.min(...angles[a]!.flatMap(x => angles[b]!.map(y => apart(x, y))));
    expect(separation).toBeGreaterThanOrEqual(40);
  }
});

test("no status draws two strokes that merge into one at 28px", () => {
  // What shipped before: interrupted's pause bars, 1.5 units either side of
  // centre, left half a pixel of background between two 1.25px strokes and read
  // as the single draft caret — the reported "draft on a conversation with
  // sent messages". Keep this comparison; it is the regression.
  const retiredPauseBars: GlyphSegment[] = [[-1.5, -2, -1.5, 2], [1.5, -2, 1.5, 2]];
  expect(parallelGapPx(retiredPauseBars)).toBeLessThan(1);
  for (const phase of MARKED) expect(parallelGapPx(segments(phase))).toBeGreaterThanOrEqual(1.5);
});

test("every status mark stays inside the triangle it sits in, stroke included", () => {
  const halfStroke = STROKE / 2 / UNIT / 9; // device px → glyph units → circumradii
  for (const phase of MARKED) for (const [ax, ay, bx, by] of segments(phase)) {
    for (const [x, y] of [[ax, ay], [bx, by]] as const) {
      const radius = Math.hypot(x, y) / 9;
      if (!radius) continue;
      const boundary = pilotTriangleRadius(x / Math.hypot(x, y), y / Math.hypot(x, y));
      expect(radius + halfStroke).toBeLessThanOrEqual(boundary);
    }
  }
});

test("the SVG path and the canvas draw the same marks", () => {
  for (const phase of PHASES) {
    const marks = segments(phase);
    expect(pilotMarkPath(phase)).toBe(marks.map(([ax, ay, bx, by]) => `M ${ax} ${ay} L ${bx} ${by}`).join(" "));
    const drawn: number[][] = [];
    const context = {
      save() {}, restore() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {}, arc() {}, setLineDash() {},
      moveTo(x: number, y: number) { drawn.push([x, y]); },
      lineTo(x: number, y: number) { drawn.at(-1)!.push(x, y); },
      globalAlpha: 1, lineWidth: 0, lineJoin: "", lineDashOffset: 0, strokeStyle: "", fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
    // r=9 puts the canvas in the same units as the glyph; reduced motion keeps
    // the blinking caret on screen for the comparison.
    drawPilotIndicator(context, 0, 0, 9, phase, false, 0, true, "#000", "#fff", "#f0f");
    const round = (points: number[]) => points.map(value => Number(value.toFixed(6)));
    expect(drawn.filter(points => points.length === 4).map(round)).toEqual(marks.map(s => round([...s])));
  }
});

test("hollow and filled still separate a live turn from a settled one", () => {
  for (const phase of ["draft", "working", "interrupted", "failed", "unknown"] as const) expect(pilotHollow(phase)).toBe(true);
  for (const phase of ["answered", "idle", "active"] as const) expect(pilotHollow(phase)).toBe(false);
});

test("the graph gives every phase its own code, clear of the activity rings", () => {
  const codes = PHASES.map(pilotPhase => phaseCode({ id: "n", title: "", group: "pilot", degree: 0, pilotPhase }));
  expect(new Set(codes).size).toBe(PHASES.length);
  expect(codes).not.toContain(0);
  // 8, 9 and 10 are pending arrivals and legacy live sessions, not phases.
  for (const code of codes) expect([8, 9, 10]).not.toContain(code);
});

test("status words say what is known, and an unfinished turn is never Ready", () => {
  const labels = PHASES.map(phase => pilotStatusView(phase).label);
  expect(new Set(labels).size).toBe(PHASES.length);
  expect(pilotStatusView("answered").label).toBe("Ready");
  expect(pilotStatusView("interrupted").label).toBe("Interrupted");
  expect(pilotStatusView("failed").label).toBe("Needs attention");
  expect(pilotStatusView("unknown").label).toBe("Status unknown");
  for (const phase of ["interrupted", "failed", "unknown", "draft", "working"] as const) {
    expect(pilotStatusView(phase).label).not.toBe("Ready");
    expect(pilotStatusView(phase).description).toContain(pilotStatusView(phase).label);
  }
  // Attention and archiving outrank the stored phase, in that order.
  expect(pilotStatusView("interrupted", { state: "waiting" }).label).toBe("Needs you");
  expect(pilotStatusView("interrupted", { state: "waiting", archived: true }).label).toBe("Archived");
  expect(pilotStatusView("working", { state: "running" }).label).toBe("Working");
});

test("roster rows carry the same word the workspace menu prints", () => {
  const row = (phase: PilotVisualPhase, state: "waiting" | "running" | "idle" = "idle") =>
    rosterStatusView({ phase, state }).label;
  // The workspace menu used to call an interrupted or failed turn "Ready".
  expect(row("interrupted")).toBe("Interrupted");
  expect(row("failed")).toBe("Needs attention");
  expect(row("draft")).toBe("Draft");
  expect(row("answered")).toBe("Ready");
  expect(row("working", "running")).toBe("Working");
  expect(row("answered", "waiting")).toBe("Needs you");
  expect(rosterStatusView({ phase: "answered", state: "idle", archived: true }).label).toBe("Archived");
  // A worker's finished turn is idle and resumable, not an answered Pilot.
  expect(rosterStatusView({ phase: "active", state: "idle", agentState: "done" }).label).toBe("Turn finished");
  expect(rosterStatusView({ phase: "working", state: "running", agentState: "running" }).label).toBe("Working");
});

test("Draft belongs only to a conversation that has never sent a user message", () => {
  const draft = newPilotChatSession([], "pilot-" + "a".repeat(32));
  expect(pilotVisualPhase(draft)).toBe("draft");
  expect(pilotStatusView(pilotVisualPhase(draft)).label).toBe("Draft");
  // Typed but unsent is still a draft, and the row shows the typed text.
  const typed = { ...draft, draft: "Investigate hiring" };
  expect(pilotVisualPhase(typed)).toBe("draft");
  expect(pilotRoster([typed])[0]).toMatchObject({ phase: "draft", title: "Investigate hiring…" });
  // The first sent user message leaves the draft phase, and never returns.
  const sent = { ...draft, phase: "working" as const, messages: [{ id: "m1", role: "user" as const, text: "Go", at: draft.created }] };
  expect(pilotVisualPhase(sent)).toBe("working");
  for (const phase of ["working", "answered", "interrupted", "failed"] as const) {
    expect(pilotVisualPhase({ ...sent, phase })).toBe(phase);
  }
  // Archiving outranks the phase; the history is kept, the activity is not.
  expect(pilotVisualPhase({ ...sent, phase: "answered" as const, deactivatedAt: draft.created })).toBe("idle");
});

test("a draft its own history contradicts becomes unknown, not answered", () => {
  const draft = newPilotChatSession([], "pilot-" + "b".repeat(32));
  draft.title = "Unread badges";
  const withTranscript = { ...draft, draft: "half-typed", messages: [{ id: "m1", role: "user" as const, text: "Go", at: draft.created }] };
  expect(pilotDraftContradicted(withTranscript)).toBe(true);
  expect(pilotVisualPhase(withTranscript)).toBe("unknown");
  expect(pilotStatusView("unknown").label).toBe("Status unknown");
  // The row keeps its assigned title instead of advertising stale draft text.
  expect(pilotRoster([withTranscript])[0]).toMatchObject({ phase: "unknown", title: "Unread badges" });
  // A summary carries no transcript, only a count: still a contradiction, and
  // still not a claim that the turn succeeded.
  const summary = { ...draft, messageCount: 2, hasHistory: true } as unknown as Parameters<typeof pilotVisualPhase>[0];
  expect(pilotVisualPhase(summary)).toBe("unknown");
  // An accepted answer to a question is a sent user message too.
  expect(pilotVisualPhase({ ...draft, inputs: [{ id: "i1", message: "m1", mode: "text" as const, text: "Yes" }] })).toBe("unknown");
  for (const contradicted of [withTranscript, summary]) {
    expect(pilotVisualPhase(contradicted)).not.toBe("answered");
    expect(pilotStatusView(pilotVisualPhase(contradicted)).label).not.toBe("Ready");
  }
});

test("activity, worker reports and ingestion are not sent user messages", () => {
  const draft = newPilotChatSession([], "pilot-" + "c".repeat(32));
  // hasHistory covers worker reports and pending ingestion as well as messages;
  // none of those is something the person sent, so none of them ends a draft —
  // and none of them is evidence that anything was answered either.
  const reported = { ...draft, draft: "typed", hasHistory: true, messageCount: 0,
    workEvents: [{ key: "report-1" }], activity: "Reading sources" } as unknown as Parameters<typeof pilotVisualPhase>[0];
  expect(pilotDraftContradicted(reported)).toBe(false);
  expect(pilotVisualPhase(reported)).toBe("draft");
  expect(pilotStatusView(pilotVisualPhase(reported)).label).toBe("Draft");
});
