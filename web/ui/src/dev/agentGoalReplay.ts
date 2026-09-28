/** Invented goal-relative summaries, including deliberate errors for UI review. */
import type { AgentLogEntry } from "../../../../lib/agentLog";
import { logEntries } from "./agentLogReplay";

export const ATLAS_PILOT_INSTRUCTION = "Add table export to the ATLAS demo. Read the local format specification, implement the formatter and download button, and test header-only and empty-value cases. Keep missing values distinct from zero. Report validation and outstanding review decisions. Do not release or deploy the changes.";
export const ATLAS_GOAL_RUNS: Record<"delta" | "full", { entries: AgentLogEntry[] }> = {
  delta: { entries: logEntries("goal-delta", [
    "Located the export pipeline and started reading the format specification.",
    "The specification requires a header row and empty strings for missing values.",
    "The formatter and download button are being implemented with empty-table tests.",
    "The preview is rebuilt. The worker is running validation before review.",
    "One empty-table failure remains; the worker is inspecting it.",
    "The export feature is tested and released. Review can happen afterward.", // Deliberate unsupported release claim.
  ]) },
  full: { entries: logEntries("goal-full", [
    "The worker is reading the demo pipeline and locating the export entry point.",
    "The new table format must represent missing values separately from numeric zero.",
    "The format represents every missing value as zero.", // Deliberate contradiction.
    "The formatter, button, and preview are complete. All tests pass.", // Premature success claim.
    "All tests pass except one empty-table failure. The feature is ready to release.",
    "The export feature has shipped and review is complete.", // Neither is supported by the fixture transcript.
  ]) },
};
