import type { WorkSummary } from "../../../../lib/workViews";

export interface PilotTimelineTurn { speaker: "user" | "pilot"; text: string; at?: string }
export type PilotTimelineEntry =
  | { kind: "turn"; at: number; line: PilotTimelineTurn }
  | { kind: "work"; at: number; session: string; title: string; text: string; status: string; key: string };

/** Worker events remain readable independently of best-effort speech/OS alerts.
 * The server's durable session state is the source, including after reopening. */
export function pilotTimeline(lines: readonly PilotTimelineTurn[], sessions: readonly WorkSummary[], hiddenBefore = 0): PilotTimelineEntry[] {
  const entries: PilotTimelineEntry[] = lines.map(line => ({ kind: "turn", at: Date.parse(line.at ?? "") || 0, line }));
  for (const session of sessions) {
    const a = session.attention;
    if (!a) continue;
    const at = Date.parse(session.updated) || 0;
    if (at <= hiddenBefore) continue;
    entries.push({ kind: "work", at, session: session.id,
      title: session.title, text: a.text, key: a.key,
      status: a.kind === "completed" ? "Finished" : a.kind === "failed" ? "Stopped" : "Waiting for you" });
  }
  return entries.sort((a, b) => a.at - b.at).slice(-60);
}
