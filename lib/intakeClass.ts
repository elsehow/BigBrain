/** Stable intake classification, shared by projection writes and readers. */

import { SESSION_VOICE_MIN_TURNS, userSide } from "./transcriptProjection";

// ── priority ────────────────────────────────────────────────────────────────

/** Intake priority classes, drained in this order (#520 comment): the
 * user's own voice first, then the day's meetings, then reading, then mail,
 * then everything else. Demand/heat can reorder later (#325/#326). */
const INTAKE_CLASSES = ["voice", "meeting", "reading", "mail", "other"] as const;
export type IntakeClass = (typeof INTAKE_CLASSES)[number];

export const CLASS_RANK: Record<IntakeClass, number> = { voice: 0, meeting: 1, reading: 2, mail: 3, other: 4 };

const MEETING_WORDS = new Set(["meeting", "transcript", "meeting-dossier"]);
const READING_WORDS = new Set([
  "web-clip", "paper", "working-paper", "article", "post", "review", "analysis",
  "podcast", "legal-document", "code", "dataset", "image", "note", "idea", "dream",
]);

export interface IntakeEnvelopeFacts {
  kind?: string | null;
  type?: string | null;
  source?: string | null;
  from_kind?: string | null;
}

/** Pure classification from envelope facts the projection can cheaply
 * extract. `agent-chat` is its own answer: a TRANSCRIPT is intake for its
 * owner's side alone, and only when there is one — `intakePriority` below
 * reads the body for that (2026-09-06, revisiting #528's "stored ground
 * truth, never read"). The special case is the transcript envelope, NOT
 * agent authorship: a deliberate agent drop (`from_kind: agent`, any other
 * kind) is distilled evidence and ranks like anything else — the gardener
 * files it (#528 re-cut, 2026-08-24). */
export function classifyIntake(
  facts: IntakeEnvelopeFacts
): IntakeClass | "agent-chat" | "observation" {
  const word = (facts.kind ?? "").trim() || (facts.type ?? "").trim();
  // Voice outranks the agent-chat exclusion (#521): a directive or request
  // is due work whoever composed it — the rendering GRADE stays from_kind's
  // job — while an observation is never due intake at all: it is the memory
  // pass's demand signal, consumed by its insertion cursor (lib/memory.ts).
  if (word === "observation") return "observation";
  if (word === "directive" || word === "request") return "voice";
  if (facts.source === "agent-chat" || word === "agent-chat" || word === "pilot-chat") return "agent-chat";
  if (MEETING_WORDS.has(word)) return "meeting";
  if (READING_WORDS.has(word)) return "reading";
  if (word === "email") return "mail";
  return "other";
}


/** A transcript's rank: strictly last. The owner's side of a session is
 * working speech, filed after every meeting, clip, mail and unclassified
 * arrival of the day. */
export const SESSION_RANK = CLASS_RANK.other + 1;

/** THE ONE INTAKE DECISION: the rank an arrival drains at, or null for a
 * record intake never touches. The projection writes it (`intake_priority`)
 * and the feed reads it (null is "record"), so the gardener's to-do list
 * and the row's mark cannot disagree. Facts are the envelope's; the body is
 * read for one class only — a transcript is intake for its owner's side
 * when there is one (SESSION_VOICE_MIN_TURNS turns typed), and a record
 * otherwise. */
export function intakePriority(facts: IntakeEnvelopeFacts, body: string): number | null {
  const klass = classifyIntake(facts);
  if (klass === "observation") return null;
  if (klass === "agent-chat") return userSide(body).turns.length >= SESSION_VOICE_MIN_TURNS ? SESSION_RANK : null;
  return CLASS_RANK[klass];
}
