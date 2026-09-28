import { expect, test } from "bun:test";
import { matchedPackets, WORKER } from "./support/smokePilotWorkerMatched";
import { ATLAS_LOG } from "../web/ui/src/dev/agentLogReplay";
import type { WorkSession } from "../lib/workHistory";
const job = { id: WORKER, status: "idle", messages: [
  { id: "launch", role: "user", at: "1", text: "The exact Pilot goal" },
  { id: "activity", role: "activity", at: "2", text: "TOOL_ONLY_DETAIL" },
  { id: "correction", role: "user", at: "3", text: "An in-flight correction" },
  { id: "complete", role: "agent", at: "4", text: "RAW_REPORT_ONLY " + "x".repeat(10_000) },
  { id: "later", role: "agent", at: "6", text: "AFTER_CUTOFF" },
], completions: [{ key: "completion", kind: "completed", at: "5", text: "EXTRA_RECEIPT" }] } as WorkSession;
test("matched log is exactly the UI fixture, with no hidden worker evidence", () => {
  const { prefix, packets: [visible, full] } = matchedPackets(job);
  expect(visible!.entries.map(e => e.text)).toEqual(ATLAS_LOG.map(e => e.text));
  expect(visible!.entries.map(e => e.at)).toEqual(ATLAS_LOG.map(e => e.at));
  expect(visible!.input).toBe(prefix + visible!.evidence);
  expect(full!.input).toBe(prefix + full!.evidence);
  expect(prefix).toContain("The exact Pilot goal");
  for (const hidden of ["TOOL_ONLY_DETAIL", "RAW_REPORT_ONLY", "EXTRA_RECEIPT", "AFTER_CUTOFF"]) expect(visible!.input).not.toContain(hidden);
});
test("full saved transcript retains all in-scope text uncut, without duplicate task/receipt or future messages", () => {
  const { packets: [, full] } = matchedPackets(job);
  expect(full!.entries).toEqual(job.messages.slice(1, 4).map(({ at, role, text }) => ({ at, role, text })));
  expect(full!.entries.at(-1)!.text).toHaveLength(10_016);
  expect(full!.evidence).not.toContain("The exact Pilot goal");
  expect(full!.evidence).not.toContain("AFTER_CUTOFF");
  expect(full!.evidence).not.toContain("EXTRA_RECEIPT");
});
