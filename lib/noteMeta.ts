/**
 * noteMeta.ts — pure note-metadata helpers for the web viewer: submission
 * date precedence and provenance banding, both over an already-parsed
 * Envelope rather than raw regex. web/server.ts is an unimportable script
 * (it binds a socket at import time), so the testable logic underneath its
 * noteWhen()/fmProvenance() lives here instead. Side-effect-free at import.
 */

import { isEntity, type Envelope } from "./envelope";
import { INTERNAL_PERSONAS } from "./personas";

/** Parse a note's own date-ish value, tolerant of bare-date vs full
 * timestamp forms — a bare date (or an importer's UTC-midnight stamp)
 * parses as UTC midnight, never server-local midnight (the host and the
 * viewer may sit in different timezones). */
export function parseNoteDate(v: string): number {
  const dm = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?Z)?$/.exec(v);
  return Date.parse(dm ? `${dm[1]}T00:00:00Z` : v);
}

/** A note's "when", given its envelope and the mtime-independent fallback
 * (the filename's YYYY-MM-DD prefix, as epoch ms, or NaN if absent).
 * Sources, most trusted first: `date` (drop.ts contract; dreams), then
 * `created`/`filed`/`updated` — but those can be an IMPORT time months
 * after the event (bulk backfills), so a key timestamp on the same day as
 * the filename prefix keeps its time-of-day; a different day means the
 * prefix wins at date precision. Returns undefined when no key resolves,
 * leaving the filename/mtime fallback to the caller. */
export function envelopeWhen(env: Envelope, fnMs: number): number | undefined {
  for (const key of ["date", "created", "filed", "updated"] as const) {
    const raw = env[key];
    if (typeof raw !== "string") continue;
    const t = parseNoteDate(raw.trim());
    if (Number.isNaN(t)) continue;
    if (key === "date" || Number.isNaN(fnMs)) return t;
    return new Date(t).toDateString() === new Date(fnMs).toDateString() ? t : fnMs;
  }
  return undefined;
}

export type ProvenanceBand = "person" | "agent" | "service" | "engine";
export interface Provenance {
  from?: string;
  band: ProvenanceBand;
  when?: number;
}

// Who is this item FROM, and WHEN did it enter the vault? Decided by the
// item's own provenance — never the last committer, so your drop stays
// yours (and keeps its submission time) after triage files and edits it.
// `from`/`from_kind` (stamped by intake, an integration, or an agent's
// self-assertion) are authoritative; items predating the stamp fall back
// to the channel heuristic: claude-code composed it → agent, a push
// channel a person drives (web drop, token client, forwarded mail) →
// person, a feed no person composed (granola, whoop) → service named by
// its source. Unstamped files and the editor's own artifacts — indexes,
// reorganizations, vault-clean requests — are engine churn.
const PERSON_CHANNELS = new Set(["web", "api", "email"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() || undefined : undefined;
}

/** A reference's "when" for the feed: its own `received` stamp (lib/references.ts
 * always writes one), falling back to the file's mtime only when `received`
 * is absent or unparseable — belt-and-suspenders, since landReference never
 * skips the stamp in practice. */
export function referenceWhen(received: string | undefined, mtimeMs: number): number {
  if (typeof received === "string") {
    const t = parseNoteDate(received.trim());
    if (!Number.isNaN(t)) return t;
  }
  return mtimeMs;
}

export type FilingStatus = "filed" | "declined" | "pending" | "record";

/** A arrival row's filing status — "filed" once a view note cites the item's
 * id (legacy id-carry counts too), else "pending", the UI's "filing…"
 * state. An id-less reference (shouldn't happen — landReference always stamps
 * one) reads as pending: an empty id can't be safely matched against
 * anything. The third status, "record", never comes from here: the feed
 * assigns it directly to `note`-typed items, which are home (and done) the
 * moment they land — the user's own words owe the editor nothing. */
export function filingStatus(
  id: string | undefined,
  citedIds: ReadonlySet<string>,
  settledIds: ReadonlySet<string> = new Set()
): FilingStatus {
  if (!id) return "pending";
  if (citedIds.has(id)) return "filed";
  // The editor read it and declined — terminal success, not limbo. Kept as a
  // distinct value rather than folded into "filed" because the two are
  // different facts (one has links, one does not) and the feed's own
  // filedPath/filedModel joins key on "filed". The UI renders both as done.
  if (settledIds.has(id)) return "declined";
  return "pending";
}

/** Newest-first merge of the reference feed (direct reads, lib/references.ts) with the
 * git-log-reconstructed feed (web/server.ts's recentFiles, kept for
 * pre-envelope history). A git row whose note id is already claimed by a reference
 * row — i.e. a reference that has since been filed — is dropped: the reference
 * row already represents that arrival (now `status: "filed"`), and keeping
 * both would show the same arrival twice under two different paths. Git
 * rows with no id, or an id no arrival row claims, pass straight through —
 * that's what keeps pre-envelope history visible.
 *
 * Before a matched git row is dropped, its own path rides onto the
 * surviving arrival row as `filedPath` (phase 4's feed collection chip — the
 * feed's only view of where a filed item landed, since the arrival row's own
 * path is `lake/YYYY/MM/<id>.md`, which names nothing a person filed), and
 * the git row's `filedModel` — the MODEL of the run that filed it, resolved
 * from the note's `triage_run` stamp via the journal (lib/noteLog.ts's
 * journalModelFor) — carries through for the filed-by column's machine-author
 * fallback. Never the git `author` and never a pass persona: the committer
 * is only the note's most-recent editor, and triage/deep/intake are
 * internal names the feed must not wear (the UI's filedByLabel owns that
 * rule). The surviving row's `modified` takes the newer of the two touches
 * (2026-08-05): the feed orders by last modification, so a filed note the
 * editor tends later bubbles up instead of staying frozen at landing. */
export function mergeRecent<
  A extends { modified: number; id?: string },
  B extends { modified: number; id?: string; path: string; filedModel?: string },
>(
  referenceRows: A[],
  gitRows: B[],
  referenceIds: ReadonlySet<string>,
  limit: number
): ((A & { filedPath?: string; filedModel?: string }) | B)[] {
  const byId = new Map<string, B>();
  for (const r of gitRows) if (r.id) byId.set(r.id, r);
  const kept = gitRows.filter((r) => !(r.id && referenceIds.has(r.id)));
  const enriched = referenceRows.map((r) => {
    const hit = r.id ? byId.get(r.id) : undefined;
    if (!hit) return r;
    // The feed orders by last touch (2026-08-05): a filed note edited after
    // its arrival surfaces at the edit, not frozen at landing time.
    return {
      ...r,
      modified: Math.max(r.modified, hit.modified),
      filedPath: hit.path,
      ...(hit.filedModel ? { filedModel: hit.filedModel } : {}),
    };
  });
  return [...enriched, ...kept].sort((a, b) => b.modified - a.modified).slice(0, limit);
}

export interface EntityMeta {
  entity?: true;
  entityType?: string;
}

/** Additive node/row metadata for a `kind: entity` note (phase 3 —
 * recognition only, see lib/envelope.ts's isEntity/entity_type): `{ entity:
 * true, entityType }` so the graph, feed, and search surfaces can render it
 * distinctly (person/place/document/thread chips). Every other note gets
 * `{}` — the empty object spreads to nothing, keeping every payload this
 * feeds additive-compatible with clients that don't know the field yet.
 * entity_type is tolerant, per the envelope contract: whatever value a note
 * carries renders as-is, never validated against the known set. */
export function entityMeta(env: Envelope): EntityMeta {
  if (!isEntity(env)) return {};
  const et = typeof env.entity_type === "string" ? env.entity_type.trim() : "";
  return et ? { entity: true, entityType: et } : { entity: true };
}

/** Provenance banding over an already-parsed envelope. Callers that read
 * the file themselves (web/server.ts) handle the unreadable-file case by
 * not calling this at all — it has no I/O of its own. */
export function fmProvenance(env: Envelope): Provenance {
  // Submission time, most trusted first: `received` (the intake stamp),
  // `fetched` (an integration's emit time), `date` (the composer's own —
  // bare dates parse as UTC midnight, fmtTs's date-only sentinel). Git
  // touch time is only the fallback: a backfill that rewrites 100 files
  // must not make them all "today".
  let when: number | undefined;
  for (const k of ["received", "fetched", "date"] as const) {
    const v = str(env[k]);
    if (!v) continue;
    const t = parseNoteDate(v);
    if (!Number.isNaN(t)) {
      when = t;
      break;
    }
  }
  const from = str(env.from);
  const fromKind = str(env.from_kind);
  if ((from || fromKind === "agent") && (fromKind === "person" || fromKind === "agent" || fromKind === "service"))
    return { from: from ?? str(env.source), band: fromKind, when };
  const source = str(env.source);
  if (source === "claude-code") return { from: "claude-code", band: "agent", when };
  if (source && PERSON_CHANNELS.has(source)) return { from, band: "person", when };
  if (source && !INTERNAL_PERSONAS.has(source) && /^[a-z][a-z0-9-]*$/.test(source))
    return { from: source, band: "service", when }; // a feed: granola, whoop-api-v2, that-tracks…
  return { band: "engine", when };
}
