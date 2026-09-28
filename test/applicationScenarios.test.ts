import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeAtomic } from "../lib/fsx";
import { validateSavedPilot } from "../lib/pilotChatPersistence";
import { pilotScenarios, runPilotScenario } from "../web/ui/src/dev/applicationScenarios";

for (const seed of [41, 73]) for (const trace of pilotScenarios(seed)) test(`application scenario: ${trace.id}, seed ${seed}`, () => {
  const root = mkdtempSync(join(tmpdir(), "application-scenario-")), file = join(root, `${trace.pilot}.json`);
  try {
    const result = runPilotScenario(trace, { write: state => writeAtomic(file, JSON.stringify(state), 0o600), read: () => validateSavedPilot(JSON.parse(readFileSync(file, "utf8")), file) });
    expect(result).toEqual(runPilotScenario(trace));
    expect(result.view.messages.map(m => m.text)).toEqual(trace.expected.messages);
    if (trace.id === "archived-report") {
      expect(result.state.workEvents).toHaveLength(1);
      expect(result.frames.flatMap(f => f.effects).filter(e => e.kind === "schedule-reports")).toEqual([]);
    }
    if (trace.id === "restart-pending") {
      expect(result.frames[1].state.revision).toBe(result.frames[0].state.revision);
      expect(result.state.turn).toBeUndefined();
    }
    if (trace.id === "cancel-queued") {
      expect(result.frames[0].effects).toEqual([{ kind: "start", turn: { id: "t1", status: "running", replyTo: "m1" } }]);
      expect(result.frames.at(-1)?.effects).toEqual([]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
