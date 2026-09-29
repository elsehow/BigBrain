/**
 * granolaNote.ts — one Granola note, as the vault receives it. The poll
 * (integrations/granola/run.ts) and the relabel pass
 * (integrations/granola/relabel.ts) build the SAME item from the vendor's
 * note object; nothing here touches the network or the vault.
 *
 * Speaker labels are the vendor's own word, carried whole. Each transcript
 * turn arrives as `{ speaker: { source, attribution, name? } }`: `name`
 * where Granola attributed the voice to a participant, `attribution: "me"`
 * for the account owner's microphone, and neither for a voice it could not
 * place. The poll used to keep only `source` and flatten every turn to
 * `microphone:`/`speaker:`, so a five-person meeting read as two voices —
 * and every assertion the gardener drew from it lost who said what.
 */

import { frontmatter, slugify } from "./fsx";

export interface GranolaTurn {
  text?: string;
  start_time?: string;
  end_time?: string;
  speaker?: { source?: string; attribution?: string; name?: string };
}

/** The vendor's note object (`GET /notes/:id?include=transcript`), the
 * fields this module reads. Everything else stays `unknown`. */
export interface GranolaNote {
  title?: string;
  created_at?: string;
  updated_at?: string;
  web_url?: string;
  owner?: { name?: string; email?: string };
  calendar_event?: {
    scheduled_start_time?: string;
    summary?: string;
    title?: string;
    calendar_event_id?: string;
  };
  attendees?: { name?: string; email?: string }[];
  summary_markdown?: string;
  summary_text?: string;
  transcript?: GranolaTurn[];
}

/** The label for a voice the vendor could not attribute. Also the label
 * every pre-relabel body used for every non-owner turn. */
export const UNATTRIBUTED = "speaker";

/** The only labels a body written before names were carried could hold —
 * what `granolaBodyHasNames` checks against. */
const FLAT_LABELS = new Set(["microphone", UNATTRIBUTED]);

export const TRANSCRIPT_MARKER = "--- VERBATIM TRANSCRIPT";

const vendorName = (turn: GranolaTurn): string | undefined => {
  const n = turn.speaker?.name;
  return typeof n === "string" && n.trim() ? n.trim() : undefined;
};

/** Name → the owner's name for `me` → `speaker`. The owner's name is the
 * vendor's too (`note.owner`), so the label never needs the vault's
 * identity — this door does no lookups. */
export function granolaTurnLabel(turn: GranolaTurn, ownerName?: string): string {
  const named = vendorName(turn);
  if (named) return named;
  if (turn.speaker?.attribution === "me") return ownerName?.trim() || "me";
  return UNATTRIBUTED;
}

export function granolaTranscriptHeader(ownerName?: string): string {
  const me = ownerName?.trim() || "me";
  return `${TRANSCRIPT_MARKER} (raw ASR; speaker labels are Granola's: a name where it attributed the voice, "${me}" for the account owner's microphone, "${UNATTRIBUTED}" for a voice it could not place) ---`;
}

export function granolaTranscriptLines(turns: GranolaTurn[], ownerName?: string): string[] {
  return turns.map((t) => `${granolaTurnLabel(t, ownerName)}: ${t.text ?? ""}`);
}

/** How many turns the vendor attributed to a named participant. The
 * owner's own turns never count: they are `me`, not a name. */
export function granolaNamedTurns(turns: GranolaTurn[] | undefined): number {
  return (turns ?? []).filter((t) => vendorName(t) !== undefined).length;
}

/** Does a landed body's transcript carry any label beyond the two flat
 * ones? Reads only the lines under the transcript marker — the attendee
 * line and the vendor summary above it are not turns. A body without a
 * marker has no transcript to speak of and answers false. */
export function granolaBodyHasNames(body: string): boolean {
  const at = body.indexOf(`\n${TRANSCRIPT_MARKER}`);
  if (at < 0) return false;
  for (const line of body.slice(at + 1).split("\n").slice(1)) {
    const m = /^([^:\n]{1,80}): /.exec(line);
    if (m && !FLAT_LABELS.has(m[1]!)) return true;
  }
  return false;
}

export interface GranolaItem {
  title: string;
  date: string;
  /** Envelope + body, ready for `receive()`. */
  content: string;
  /** The inbox slot name `receive()` wants. */
  name: string;
}

const ymd = (iso: string | undefined) => (iso ?? "").slice(0, 10) || "undated";

/** Build the item the intake waist lands. `supersedes` names the prior
 * insertion this one revises when the caller KNOWS it (the relabel pass
 * does; the poll never does — envelope.ts's rule). */
export function granolaItem(
  id: string,
  note: GranolaNote,
  now: Date,
  opts: { supersedes?: string } = {}
): GranolaItem {
  const title = note.title ?? "(untitled meeting)";
  const date = ymd(note.calendar_event?.scheduled_start_time ?? note.created_at);
  const participants = (note.attendees ?? []).map((a) => ({
    raw: `${a.name ?? a.email ?? "?"}${a.email ? ` <${a.email}>` : ""}`,
    ...(typeof a.name === "string" && a.name.trim() ? { name: a.name.trim() } : {}),
    ...(typeof a.email === "string" && a.email.trim() ? { emails: [a.email.trim().toLowerCase()] } : {}),
    role: "attendee",
  }));
  const attendees = participants.map((a) => a.raw).join(", ");
  const ownerName = note.owner?.name;

  // Import source evidence only; summaries and ASR rewriting are not intake tasks.
  const body = [
    `# ${title}`,
    ``,
    `Attendees: ${attendees || "(none listed)"}`,
    ``,
    granolaTranscriptHeader(ownerName),
    ``,
    ...granolaTranscriptLines(note.transcript ?? [], ownerName),
    ``,
  ].join("\n");

  // The vendor's own title(s) — carried as aliases so the note stays findable
  // by the name it arrived under even after triage renames it (the retrieval
  // index resolves aliases). Calendar title included when it differs.
  const calTitle = (note.calendar_event?.summary ?? note.calendar_event?.title ?? "").trim();
  const aliases = [...new Set([title, calTitle].filter((t) => t && t !== "(untitled meeting)"))];

  const fm = frontmatter([
    ["id", `granola-${id}`],
    ["source", "granola"],
    // no person composed this — the integration is the sender (a service)
    ["from", "granola"],
    ["from_kind", "service"],
    ["kind", "meeting"],
    // strong type + descriptive tags, declared at the source (drop-zone
    // cut 3): the integration KNOWS it delivers an external record of a
    // meeting — facts, not guesses
    ["type", "reference"],
    ["tags", ["transcript", "meeting"]],
    ["title", title],
    ...(aliases.length ? ([["aliases", aliases]] as [string, string[]][]) : []),
    ["date", date],
    ["attendees", attendees || "(none listed)"],
    ...(participants.length ? ([["participants", participants]] as [string, typeof participants][]) : []),
    ["url", note.web_url ?? ""],
    ["event_id", note.calendar_event?.calendar_event_id ?? ""],
    ["fetched", now.toISOString()],
    // Arrival identity (#46) — the opportunistic retrofit the envelope
    // spec asks integrations for, and it costs nothing here: the vendor
    // already hands us both. One account, so `stream` is the vendor name;
    // `key` is Granola's own note id, so a re-emitted note (a `--since`
    // re-poll, an edited summary, a relabel) is legible as the SAME
    // meeting rather than a second one. `seq` is the vendor's own
    // last-update stamp — its ordering, not ours, which is the whole point
    // of the field. `supersedes` names a prior LAKE id: the poll leaves it
    // unset (knowing it would mean a lookup this door has no business
    // doing); the relabel pass, which read that id off the log, sets it.
    ["stream", "granola"],
    ["key", id],
    ["seq", note.updated_at ?? note.created_at ?? now.toISOString()],
    ...(opts.supersedes ? ([["supersedes", opts.supersedes]] as [string, string][]) : []),
  ]);

  return {
    title,
    date,
    content: fm + "\n" + body,
    name: `${date}-${slugify(title)}-${id}.md`,
  };
}
