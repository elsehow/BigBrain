/** Invented export-tool task and progress logs. No private conversation excerpts. */
import type { AgentLogEntry } from "../../../../lib/agentLog";
import type { GraphData } from "../lib/types";
import { agentChatFixture } from "./agentChatScenes";

export const replayAt = (i: number): string => `2026-01-01T12:${String(i * 5).padStart(2, "0")}:00.000Z`;
export const logEntries = (prefix: string, texts: (string | null)[]): AgentLogEntry[] => texts.flatMap((text, i) => text
  ? [{ id: `${prefix}-${i}`, at: replayAt(i + 1), text, evidence: [`E${i + 1}-0`] }] : []);
export const ATLAS_LOG = logEntries("atlas-log", [
  "Reading the demo export pipeline to find where a table format belongs.",
  "Found the format specification. Checking how empty values should be represented.",
  "Writing the formatter, download button, and tests.",
  "The demo page is rebuilt. Checking the download preview and running the tests.",
  "One test still fails for an empty table. Investigating before handing the changes back.",
  "The worker reports the export feature is implemented and tested. Nothing is committed, merged, or deployed; review and release are still pending.",
]);
// Deliberately incomplete/trivial summaries exercise the alternate copy mode.
export const ATLAS_QUICK_LOG = logEntries("atlas-quick", [
  null,
  "The table format uses a header row and an empty string for missing values.",
  "Added a formatter helper and a button label. Writing tests next.",
  "The output schema is pinned and the demo page rebuilt. Checking the preview.",
  "One empty-table test remains. The generated archive is excluded from Git.",
  "Table export is implemented and tested; review and release are pending.",
]);
export const ATLAS_GRAPH: GraphData = {
  hash: "atlas-log-replay",
  nodes: [
    { id: "memory/atlas", path: "memory/atlas", title: "ATLAS", group: "memory", degree: 2, x: 80, y: 20 },
    { id: "memory/reviewer", path: "memory/reviewer", title: "Demo reviewer", group: "entity", degree: 1, x: -110, y: 110 },
  ], edges: [{ source: "memory/reviewer", target: "memory/atlas" }],
};
export function atlasLogFixture(scene: string) {
  const session = agentChatFixture("running");
  Object.assign(session, {
    title: "Add table export to the ATLAS demo", model: "Fable", cwd: "/demo/atlas",
    created: "2026-01-01T12:00:00.000Z", updated: replayAt(6),
    status: scene === "quick-summarizing" ? "working" : "idle",
    context: { nodes: ATLAS_GRAPH.nodes.map(n => n.id), title: "ATLAS" },
  });
  const updates = [
    "I'll inspect the demo export pipeline before adding a table formatter.",
    "The format specification calls for a header row and empty strings for missing values.",
    "I'm adding the formatter, a download button, and empty-table coverage.",
    "The output schema is pinned and the demo page rebuilt. I'm checking the preview and running the tests.",
    "One empty-table test still fails. I'll inspect its assertion and exclude the generated archive from Git.",
    "The table export is implemented on the demo branch. All 24 tests pass. No commit, merge, release, or deployment has happened. Review is pending.",
  ];
  session.messages = [
    { id: "task", at: session.created, role: "user", text: "Add table export to the ATLAS demo. Preserve empty values, test the download, and leave release decisions for review." },
    ...updates.map((text, i) => ({ id: `update-${i}`, at: replayAt(i + 1), role: "agent" as const, text })),
  ];
  return session;
}
