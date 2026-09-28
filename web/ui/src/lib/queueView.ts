// Pure view logic over the QUEUE PAYLOAD, kept out of the components so it's
// testable with plain `bun test` (Svelte components aren't).
//
// Most of this file was the work-queue screen's — the depth summary, the run
// grouping, the two passes interleaved into one history column. That screen
// was deleted on 2026-08-28 and its logic went with it. What remains is what
// OTHER surfaces read the queue for, and they are the reason the endpoint
// stays: home's intake spinner (when will this row be filed?) and a note's
// directives (what did anyone ask about THIS?).

import { messageKind, type QueueMessageRow } from "./types";

// Re-exported (not just used below): lib/viewTypes.ts is the one
// declaration, but every existing `messageKind` import off this module
// (test/queueView.test.ts) keeps resolving here (#261).
export { messageKind };

/** An item's editorial verdict, read off the runner-stamped outcome/error —
 * never model prose. Multi-ref messages take the strongest signal.
 * Module-private since the queue screen went: directiveStatus is its one
 * consumer. */
function itemStatus(m: Pick<QueueMessageRow, "state" | "outcome" | "error">): string {
  if (m.state === "failed") return "failed";
  const o = m.outcome ?? "";
  if (o.includes("absorbed")) return "absorbed";
  if (o.includes("declined")) return "declined";
  if (o.includes("tended")) return "tended";
  return "";
}

/** "4m" / "2h 51m" — the pass chip's clock format. */
function fmtEta(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h${rem ? ` ${rem}m` : ""}`;
}

/** The recent feed's STATUS tooltip, for a row the editor has not absorbed
 * yet: WHAT the pass will do to it and WHEN (Nick, 2026-08-10: "hovering
 * over shows tooltip that tells you when it WILL be ingested (e.g.
 * 'building links in 5m' / 'building links now')"). A tooltip, not a chip,
 * so it names the WORK rather than the pass — a reader hovering a spinner
 * is asking what is missing from their vault, not which program is late.
 *
 * `running` is a fact off the ledger — this row's own message claimed by a
 * live run — never inferred from the clock. Absent that, the gate's own
 * arithmetic answers: an open gate reads "now" because the next tick starts
 * the run.
 *
 * An UNKNOWN eta also reads "now" (Nick, 2026-08-10). It means no local
 * intake stamp — the work is in hand, and a feed spinner is the wrong place
 * to explain why. */
export function ingestEtaLabel(
  nextEtaMs: number | null,
  running = false,
  tickMs?: number | null
): string {
  if (running || nextEtaMs === null) return "building links now";
  if (nextEtaMs > 0) return `building links in ${fmtEta(nextEtaMs)}`;
  // An eta of 0 means one of two things, and `tickMs` is how the payload
  // says which (lib/queueHead.ts): present = the eta is a floor, not a time,
  // so name the bound; absent = the supervisor published its own clock and
  // 0 really is imminent.
  //
  // This mattered: 0 was ALL this ever received, "now" was the only thing
  // it ever said, and the spinner it labels ran from the moment of arrival —
  // so it claimed the work was underway for the entire wait before it was.
  return tickMs && tickMs > 60_000
    ? `building links within ~${Math.ceil(tickMs / 60_000)}m`
    : "building links now";
}

// ── what was ASKED about one note (#50, note side) ──────────────────────────
// Standing on a note, what did anyone ask about THIS? (Nick, 2026-08-06:
// "when we click a note in the UI, we can list the directives that apply to
// it.")

/** Directives only. The route hands back every message naming the note, but
 * an arrival says nothing a reader wants here — "this item arrived" is
 * already the note's existence, and the touched-by log covers the rest —
 * and a repair is runner-computed bookkeeping, not something a mind said.
 * What belongs on a note is the guidance attached to it. */
export function directivesFor(messages: readonly QueueMessageRow[]): QueueMessageRow[] {
  return messages
    .filter((m) => messageKind(m) === "directive")
    .sort((a, b) => (b.enqueued ?? "").localeCompare(a.enqueued ?? ""));
}

/** A directive's fate, in the reader's terms rather than the queue's: not
 * yet acted on, or the editorial verdict the runner recorded. `waiting`
 * covers pending AND running — from a note's point of view a claimed
 * message is still an open question. */
export function directiveStatus(m: Pick<QueueMessageRow, "state" | "outcome" | "error">): string {
  if (m.state === "pending" || m.state === "running") return "waiting";
  return itemStatus(m);
}

/** A directive long enough to bury the note it sits under. Most are a
 * phrase ("re EU vs US") and should render whole; but nothing stops one
 * being a considered request, and the 2026-08-06 migration wrote 750-char
 * ones — two of those under a note is a wall of text where the note should
 * be. Thresholds on characters AND lines, because either alone misses a
 * case: a dozen short lines is tall without being long, and one unbroken
 * paragraph is long without having lines. Deterministic on the text, so the
 * affordance is testable and never waits on a measured box. */
export const GUIDANCE_CLAMP_CHARS = 220;
const GUIDANCE_CLAMP_LINES = 4;

export function guidanceIsLong(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  return t.length > GUIDANCE_CLAMP_CHARS || t.split("\n").length > GUIDANCE_CLAMP_LINES;
}

/** WHOSE words these are — the credential-derived split, never a claim from
 * the payload. A verified person's text is their voice and is shown as
 * theirs; anything else is an agent's, which the editor weighs as data, and
 * the reader is told which they are looking at. Absent from_kind is
 * agent-grade, matching the emitters' own default. */
export function directiveVoice(m: Pick<QueueMessageRow, "from" | "via" | "from_kind">): {
  who: string;
  person: boolean;
} {
  return { who: m.from || "unknown", person: m.from_kind === "person" };
}
