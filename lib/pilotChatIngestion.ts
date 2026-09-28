import type { PilotChatSession } from "./pilotChatTypes";
import { fmBody, fmRaw, fmSerialize } from "./wire";
import { PILOT_TRANSCRIPT_MARK } from "./transcriptProjection";

/** One immutable chapter. Persist these exact bytes before landing so a retry
 * after a crash deduplicates even if the session has since changed. */
export function pilotChatChapter(s: PilotChatSession, at: string): { through: number; content: string } {
  const start = s.ingestedMessages ?? 0, through = s.messages.length;
  const turns = s.messages.slice(start, through);
  const fm = fmSerialize([
    ["id", `${s.id}-messages-${start}-${through}`], ["source", "pilot"],
    ["from", "pilot"], ["from_kind", "agent"], ["kind", "pilot-chat"], ["type", "reference"],
    ["title", s.title], ["date", turns.at(-1)!.at.slice(0, 10)], ["fetched", at],
    ["stream", "pilot:text"], ["key", s.id], ["seq", fmRaw(String(start))],
    ["tags", fmRaw('["pilot", "transcript"]')], ["pilot_session", s.id], ["pilot_model", s.model],
    ["pilot_seed", fmRaw(JSON.stringify(s.seed))], ["pilot_context", fmRaw(JSON.stringify(s.context))],
    ["pilot_view_revision", fmRaw(String(s.viewRevision))],
  ]);
  return { through, content: fmBody(fm, [
    `# ${s.title}`, "", `Text Pilot session ${s.id}, messages ${start + 1}–${through}.`, "",
    PILOT_TRANSCRIPT_MARK, "",
    ...turns.map(m => `${m.role === "user" ? "user" : "pilot"}: ${m.text.replace(/\n(?=(?:user|pilot|assistant|harness): )/g, "\n  ")}`),
  ].join("\n\n")) };
}
