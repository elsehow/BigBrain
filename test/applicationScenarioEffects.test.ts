import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationActions } from "../lib/applicationActions";
import { writeAtomic } from "../lib/fsx";
import { transitionPilot } from "../lib/pilotTransitions";
import { pilotChatDetail } from "../lib/pilotChatSummary";
import { ApplicationCursor, applicationResponseCurrent } from "../web/ui/src/lib/applicationUpdates";
import { acceptsPilotView, fullPilotView } from "../web/ui/src/lib/pilotChatSync";
import { pilotScenarios, runPilotScenario, scenarioClock } from "../web/ui/src/dev/applicationScenarios";

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
