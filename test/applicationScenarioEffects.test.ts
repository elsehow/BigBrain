import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOrchestrator } from "../lib/agentOrchestrator";
import { ApplicationActions } from "../lib/applicationActions";
import { writeAtomic } from "../lib/fsx";
import { transitionPilot } from "../lib/pilotTransitions";
import { workDetail } from "../lib/workViews";
import { pilotChatDetail } from "../lib/pilotChatSummary";
import { ApplicationCursor, applicationResponseCurrent } from "../web/ui/src/lib/applicationUpdates";
import { acceptsPilotView, fullPilotView } from "../web/ui/src/lib/pilotChatSync";
import { pilotScenarios, runPilotScenario, scenarioClock } from "../web/ui/src/dev/applicationScenarios";
import { fakePi } from "./support/pi";
import { nativeVault } from "./support/vault";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

const workerTrace = ["launch", "stale-approval", "approve-read", "widen-saved-policy", "revoke", "late-result", "restart"] as const;
async function workerScenario() {
  const root = nativeVault(), project = realpathSync(mkdtempSync(join(tmpdir(), "scenario-project-")));
  const entered = deferred<void>(), completion = deferred<{ result: string }>();
  let calls = 0;
  const agents = new AgentOrchestrator(root, { loadPi: fakePi(async () => { calls++; entered.resolve(); return completion.promise; }) });
  const frames: unknown[] = [];
  let job!: ReturnType<AgentOrchestrator["launch"]>, restored: AgentOrchestrator | undefined;
  let approval = "";
  try {
    for (const step of workerTrace) {
      if (step === "launch") { job = agents.launch("pilot-fixture", "input-fixture", { title: "Invented review", task: "Read the sample project", context: "Fabricated context", cwd: project, mode: "read" }, []); approval = job.worker.request!.id; }
      if (step === "stale-approval") {
        expect(() => agents.approve(job.id, "stale", true, true)).toThrow("no longer pending");
        expect(() => agents.answer("pilot-fixture", job.id, approval, "Approved", [])).toThrow("context");
        expect(job.worker.grant).toBeUndefined(); expect(calls).toBe(0);
      }
      if (step === "approve-read") { agents.approve(job.id, approval, true, true); await entered.promise; }
      if (step === "widen-saved-policy") { const p = agents.projects.get(job.worker.projectId!)!; agents.projects.save({ ...p, mode: "work" }); expect(job.worker.grant?.mode).toBe("read"); }
      if (step === "revoke") { agents.projects.remove(job.worker.projectId!); expect(job.status).toBe("interrupted"); expect(() => agents.approve(job.id, approval, true, true)).toThrow("no longer pending"); }
      if (step === "late-result") { completion.resolve({ result: "Stale worker result" }); await agents.settled(job.id); expect(job.messages.some(m => m.text === "Stale worker result")).toBe(false); }
      if (step === "restart") { agents.close(); restored = new AgentOrchestrator(root, { loadPi: async () => { throw new Error("No restart replay"); } }); job = restored.get(job.id); await expect(restored.message(job.id, "Continue")).rejects.toThrow("revoked"); }
      const view = workDetail(job);
      frames.push({ step, status: view.status, mode: view.worker?.grant?.mode ?? null, request: view.worker?.request?.kind ?? null,
        messages: view.messages.map(m => m.text), calls });
    }
    expect(frames).toMatchObject([
      { status: "needs-input", mode: null, calls: 0 }, { status: "needs-input", mode: null, calls: 0 },
      { status: "working", mode: "read", calls: 1 }, { status: "working", mode: "read", calls: 1 },
      { status: "interrupted", mode: "read", calls: 1 }, { status: "interrupted", mode: "read", calls: 1 }, { status: "interrupted", mode: "read", calls: 1 },
    ]);
    return frames;
  } catch (error) { throw new Error(`Worker trace: ${JSON.stringify(workerTrace)}\nFrames: ${JSON.stringify(frames)}\n${error}`); }
  finally { completion.resolve({ result: "Cleanup" }); agents.close(); restored?.close(); await agents.settled(job?.id); rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
}

test("shared worker authority trace is repeatable across real Pi and persistence boundaries", async () => {
  expect(await workerScenario()).toEqual(await workerScenario());
}, 20_000);

for (const crash of ["prepared", "completed"] as const) test(`Pilot cancellation → action ${crash} crash → restart has no duplicate effect`, async () => {
  const trace = pilotScenarios(41).find(t => t.id === "cancel-queued")!, pilot = runPilotScenario(trace);
  const root = mkdtempSync(join(tmpdir(), "scenario-action-"));
  const clock = scenarioClock(trace.seed); let executions = 0;
  const request = { actor: { kind: "pilot" as const, id: trace.pilot }, request: "contribution", operation: "drop", scope: [trace.pilot], payload: { text: "Fabricated source" } };
  const host = { authorize() {}, execute() { executions++; return { id: "saved-source" }; } };
  try {
    const actions = new ApplicationActions(root, { now: clock.now, write(path, receipt) {
      if (crash === "completed" && receipt.status === "completed") throw new Error("Crash after effect");
      writeAtomic(path, JSON.stringify(receipt), 0o600);
      if (crash === "prepared" && receipt.status === "prepared") throw new Error("Crash before dispatch");
    } });
    await expect(actions.execute(request, host)).rejects.toThrow("Crash");
    const restartedPilot = transitionPilot(pilot.state, { kind: "restart" });
    expect(restartedPilot.effects).toEqual([]); expect(restartedPilot.state.pendingInputs).toHaveLength(1);
    const restarted = new ApplicationActions(root, { now: clock.now });
    if (crash === "prepared") expect(await restarted.execute(request, host)).toEqual({ id: "saved-source" });
    else await expect(restarted.execute(request, host)).rejects.toThrow("uncertain outcome");
    expect(executions).toBe(1);
    expect(restarted.list(request.actor).receipts[0].status).toBe(crash === "prepared" ? "completed" : "uncertain");
    expect(pilotChatDetail(restartedPilot.state).phase).toBe("interrupted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missed revisions, out-of-order detail and engine restart retain the latest view and browser draft", () => {
  const trace = runPilotScenario(pilotScenarios(73).find(t => t.id === "resume-after-cancel")!);
  const cursor = new ApplicationCursor();
  const browser = { draft: "Unsent observation", view: fullPilotView(pilotChatDetail(trace.frames[0].state)) };
  const deliveries = [
    { epoch: "first", revision: 0, snapshot: true, frame: 0 },
    { epoch: "first", revision: 2, frame: trace.frames.length - 1 }, // lost batch requires snapshot
    { epoch: "first", revision: 1, frame: 1 }, // delayed batch
    { epoch: "first", revision: 2, frame: 1 }, // duplicate batch
    { epoch: "second", revision: 0, snapshot: true, frame: trace.frames.length - 1 },
  ];
  let snapshots = 0;
  for (const delivery of deliveries) {
    const update = cursor.receive({ ...delivery, entities: [] });
    if (!update) continue;
    if (update.snapshot) snapshots++;
    const incoming = pilotChatDetail(trace.frames[delivery.frame].state);
    if (applicationResponseCurrent(delivery.epoch, cursor) && acceptsPilotView(browser.view, incoming, true)) browser.view = fullPilotView(incoming);
  }
  // A pre-restart HTTP response and a lower entity revision both fail the production guards.
  expect(applicationResponseCurrent("first", cursor)).toBe(false);
  expect(acceptsPilotView(browser.view, pilotChatDetail(trace.frames[1].state), true)).toBe(false);
  expect(snapshots).toBe(3); expect(browser.draft).toBe("Unsent observation");
  expect(browser.view.messages.map(m => m.text)).toEqual(trace.outcome.messages);
  expect(browser.view.phase).toBe("answered");
});
