/** Fabricated traces shared by bun tests and the production AppShell workbench.
 * Only the clock, persistence and effect delivery are controlled here. */
import { newPilotChatSession, type PilotChatSession } from "../../../../lib/pilotChatTypes";
import { transitionPilot, type PilotEvent, type PilotEffect } from "../../../../lib/pilotTransitions";
import { pilotChatDetail } from "../../../../lib/pilotChatSummary";
export interface ScenarioStep { event: PilotEvent; error?: string }
export interface PilotScenario {
  id: string; title: string; seed: number; at: string; pilot: string; steps: ScenarioStep[];
  expected: { phase: PilotChatSession["phase"]; lifecycle: PilotChatSession["lifecycle"]; messages: string[]; queued: number; starts: number };
}
export interface ScenarioPersistence { write(state: PilotChatSession): void; read(): PilotChatSession }
export function scenarioClock(seed: number) {
  let tick = 0;
  return { id: `pilot-${(seed >>> 0).toString(16).padStart(32, "0")}`, now: () => new Date(Date.UTC(2026, 8, 26, 12) + seed * 1000 + tick++ * 1000).toISOString() };
}
export function pilotScenarios(seed = 41): PilotScenario[] {
  const clock = scenarioClock(seed), at = clock.now();
  const input = (n: number, text = `Question ${n}`): ScenarioStep => ({ event: { kind: "input", input: { id: `input-${n}`, text, mode: "text" }, message: `m${n}`, turn: `t${n}`, at: clock.now(), queue: true } });
  const first = input(1), second = input(2);
  const stop: ScenarioStep = { event: { kind: "stop", at: clock.now() } };
  const settled: ScenarioStep = { event: { kind: "settled", turn: "t1", outcome: "answered", at: clock.now(), advance: true } };
  const cancel = [first, second, stop, { ...input(3), error: "stopping" }, { event: { kind: "delta", turn: "t1", text: "Late text" } } as ScenarioStep, settled];
  const base = { seed, at, pilot: clock.id };
  return [
    { ...base, id: "cancel-queued", title: "Cancelled with a queued follow-up", steps: cancel,
      expected: { phase: "interrupted", lifecycle: "active", messages: ["Question 1"], queued: 1, starts: 1 } },
    { ...base, id: "resume-after-cancel", title: "Resumed after a late completion", steps: [...cancel,
      { event: { kind: "resume", message: "m2", turn: "t2", at: clock.now() } },
      { event: { kind: "settled", turn: "t1", outcome: "failed", at: clock.now(), advance: true } },
      { event: { kind: "message", turn: "t1", message: { id: "late", role: "assistant", text: "Stale answer", at } } },
      { event: { kind: "message", turn: "t2", message: { id: "answer", role: "assistant", text: "Current answer", at: clock.now() } } },
      { event: { kind: "settled", turn: "t2", outcome: "answered", at: clock.now(), advance: false } }],
      expected: { phase: "answered", lifecycle: "active", messages: ["Question 1", "Question 2", "Current answer"], queued: 0, starts: 2 } },
    { ...base, id: "restart-pending", title: "Restart with pending input", steps: [first, first, { ...input(1, "Conflicting delivery"), error: "different message" }, second,
      { event: { kind: "restart" } }, { event: { kind: "delta", turn: "t1", text: "Stale after restart" } }],
      expected: { phase: "interrupted", lifecycle: "active", messages: ["Question 1"], queued: 1, starts: 1 } },
    { ...base, id: "archived-turn", title: "Archived before a turn finishes", steps: [first,
      { event: { kind: "deactivate", at: clock.now() } }, settled],
      expected: { phase: "interrupted", lifecycle: "dormant", messages: ["Question 1"], queued: 0, starts: 1 } },
    { ...base, id: "completion-before-stop", title: "Completed before Stop arrived", steps: [first,
      { event: { kind: "message", turn: "t1", message: { id: "answer", role: "assistant", text: "Confirmed answer", at: clock.now() } } }, settled, stop],
      expected: { phase: "answered", lifecycle: "active", messages: ["Question 1", "Confirmed answer"], queued: 0, starts: 1 } },
  ];
}
export function runPilotScenario(trace: PilotScenario, persistence?: ScenarioPersistence) {
  let state = { ...newPilotChatSession([], trace.pilot, trace.at), title: trace.title };
  let bytes = JSON.stringify(state);
  const store = persistence ?? { write(s: PilotChatSession) { bytes = JSON.stringify(s); }, read() { return JSON.parse(bytes) as PilotChatSession; } };
  store.write(state);
  const frames: { event: PilotEvent; state: PilotChatSession; effects: PilotEffect[]; error?: string }[] = [];
  for (const [index, step] of trace.steps.entries()) {
    let effects: PilotEffect[] = [], error: string | undefined;
    if (step.event.kind === "restart") state = store.read();
    try {
      const before = JSON.stringify(state);
      const result = transitionPilot(state, step.event);
      if (JSON.stringify(state) !== before) throw new Error("Transition mutated its input state");
      effects = result.effects;
      if (result.state !== state) { state = { ...result.state, revision: state.revision + 1 }; store.write(state); }
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    if (step.error ? !error?.includes(step.error) : !!error)
      throw new Error(`${trace.id} seed=${trace.seed} step=${index}\nInput: ${JSON.stringify(step)}\nError: ${error}\nState: ${JSON.stringify(state)}\nPrior frames: ${JSON.stringify(frames)}`);
    frames.push({ event: step.event, state: structuredClone(state), effects: structuredClone(effects), ...(error ? { error } : {}) });
  }
  const outcome = { phase: state.phase, lifecycle: state.lifecycle, messages: state.messages.map(m => m.text), queued: state.pendingInputs?.length ?? 0,
    starts: frames.flatMap(f => f.effects).filter(e => e.kind === "start").length };
  if (JSON.stringify(outcome) !== JSON.stringify(trace.expected)) throw new Error(`${trace.id} seed=${trace.seed}\nExpected: ${JSON.stringify(trace.expected)}\nActual: ${JSON.stringify(outcome)}\nTrace: ${JSON.stringify(frames)}`);
  return { state, view: pilotChatDetail(state), frames, outcome };
}
