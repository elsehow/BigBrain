import { expect, test } from "bun:test";
import { pilotTimeline } from "../web/ui/src/lib/pilotTimeline";
import type { WorkSummary } from "../lib/workHistory";

test("claimed worker failures remain readable in Pilot after voice loss or reload", () => {
  const s: WorkSummary = { id: "work-one", title: "Interview prep", cwd: "/tmp", provider: "claude-code", status: "failed", context: {}, created: "2026-09-09T12:00:00Z", updated: "2026-09-09T12:05:00Z",
    attention: { key: "failure-one", session: "work-one", title: "Interview prep", kind: "failed", text: "Research timed out", questions: [], announced: true } };
  const timeline = pilotTimeline([{ speaker: "user", text: "Research this", at: s.created }, { speaker: "pilot", text: "Sent", at: "2026-09-09T12:00:01Z" }], [s]);
  expect(timeline.at(-1)).toMatchObject({ kind: "work", key: "failure-one", status: "Stopped", text: "Research timed out" });
  expect(pilotTimeline([], [s])[0]).toMatchObject({ key: "failure-one" });
  expect(pilotTimeline([], [{ ...s, attention: undefined, status: "working" }])).toEqual([]);
});
