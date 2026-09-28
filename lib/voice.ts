/**
 * voice.ts — USER VOICE AS ARRIVALS (#521, work-as-a-view): a directive
 * (the note typed beside a clip), a request ("merge these two entities"),
 * an observation (the agent's `--why`) each land as an ordinary insertion
 * event with a `kind`, in the same log as every other arrival, under the
 * same sender-identity rules. The GRADE of what a sender may mean is the
 * envelope's `from_kind` — stamped by the door from its verified
 * credential, never trusted from the payload — and consumers render person
 * voice verbatim, agent voice framed as data (the queue emitters' rule,
 * now carried by the one arrival envelope).
 *
 * Nothing is enqueued. "Due" for a directive or request is the intake
 * predicate itself — no assertion and no decline cites it yet — so the
 * gardener drains voice first (lib/work.ts ranks the class at 0) and
 * settles it by citing it. An observation is DEMAND evidence for the
 * memory pass, never an intake job: it is excluded from the due set and
 * read from the memory stamp's insertion cursor instead (lib/memory.ts).
 *
 * A voice arrival keeps its attachment as `about:` in the envelope —
 * source ids it is about (the clip's, the entity note's), canonicalized
 * and existence-checked at landing. This generalizes the drop zone's
 * legacy single-string `about:` stamp; readers stay tolerant of both.
 *
 * This module + the validated drop door are the only ways a mind's words
 * enter the record — the stored queue's emitters (`queue/`, `requests/`,
 * `observations/`) retire as frozen history with the editor pass (#498).
 */

import { voiceReadModel } from "./vaultReadModel";
import { newItemId, type Envelope } from "./envelope";
import { clip, str } from "./text";
import { appendSourceInsertion, readSourceInsertionLog } from "./insertionLog";
import { commitSourceInsertionEvents, insertionEventRel } from "./insertionLog";
import {
  openAssertionProjectionReadonly,
  projectSourceInsertion,
  syncAssertionProjection,
} from "./assertionProjection";

import { aboutIds, isVoiceKind, VOICE_KINDS, type VoiceKind } from "./voiceFacts";
export { VOICE_KINDS, VOICE_DUE_KINDS, isVoiceKind, isVoiceInsertion, aboutIds, type VoiceKind } from "./voiceFacts";

export type VoiceErrorCode =
  | "bad-kind"
  | "empty-message"
  | "bad-guidance"
  | "bad-about"
  | "bad-query"
  | "bad-urgency"
  | "bad-principal";

/** A voice-landing contract violation — the doors map it to their 400,
 * exactly as they mapped QueueError before the queue retired. */
export class VoiceError extends Error {
  code: VoiceErrorCode;
  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Who is speaking, derived from a front door's CREDENTIAL (bearer token,
 * verified edge email, local account) — never from the payload. Same shape
 * the queue's Principal carried; redeclared here so nothing voice-side
 * imports the retiring queue module. */
export interface VoicePrincipal {
  from: string;
  via: string;
  from_kind?: "person" | "agent";
}

export interface VoiceDraft {
  kind: VoiceKind;
  /** The words themselves. Optional for a directive/request that only
   * points (`about` non-empty); required for an observation. */
  text?: string;
  /** Source ids (or insertion event ids — canonicalized) this is about. */
  about?: string[];
  /** Observation only: the search this `--why` rode on. */
  query?: string;
  /** Observation only. Accepted for the envelope's sake (old events carry
   * it) — the memory pass stopped reading it on 2026-09-02; every voice
   * arrival waits for the scheduled sweep. */
  urgency?: "now";
  now?: Date;
}

export interface VoiceLanding {
  /** The immutable insertion event's id (`ins_…`) — what an assertion or
   * decline cites to settle this. */
  id: string;
  /** The envelope's own id — the door-stamped source id. */
  source_id: string;
  /** Vault-relative path of the insertion event. */
  path: string;
  title: string;
}

const firstLine = (text: string): string => text.split("\n", 1)[0]!.trim();

/** Canonicalize + existence-check `about` against the projection: a source
 * id passes through, an insertion event id resolves to its source id, and
 * an id the record does not hold refuses the landing — a directive
 * pointing at nothing is exactly the orphan the DropZone guard already
 * refuses client-side. */
function canonicalizeAbout(root: string, raw: readonly string[]): string[] {
  if (!raw.length) return [];
  syncAssertionProjection(root);
  const db = openAssertionProjectionReadonly(root);
  try {
    const out: string[] = [];
    for (const id of raw) {
      const bySource = db.query("SELECT source_id FROM sources WHERE source_id = ? LIMIT 1").get(id) as
        | { source_id: string }
        | null;
      const byInsertion = bySource
        ? null
        : (db.query("SELECT source_id FROM sources WHERE insertion_id = ? LIMIT 1").get(id) as
            | { source_id: string }
            | null);
      const resolved = bySource?.source_id ?? byInsertion?.source_id;
      if (!resolved)
        throw new VoiceError("bad-about", `about names nothing in the record: ${id}`);
      if (!out.includes(resolved)) out.push(resolved);
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Land one voice arrival: validate → canonicalize `about` → append the
 * immutable insertion event → project it (fail-soft) → commit. A mind's
 * words are the one thing replay cannot regenerate (#67), so the commit is
 * immediate, and fail-soft like every landing commit — the event is safe
 * on disk either way.
 *
 * `idPrefix` names the DOOR (api / web / cli), the same convention every
 * front door's `newItemId` stamp has always carried.
 */
export function landVoice(
  root: string,
  draft: VoiceDraft,
  principal: VoicePrincipal,
  opts: { idPrefix?: string } = {}
): VoiceLanding {
  if (!isVoiceKind(draft.kind))
    throw new VoiceError("bad-kind", `kind must be one of ${VOICE_KINDS.join(", ")}`);
  const text = typeof draft.text === "string" ? draft.text.trim() : "";
  if (draft.text !== undefined && typeof draft.text !== "string")
    throw new VoiceError("bad-guidance", "text must be a string when present");
  const rawAbout = draft.about ?? [];
  if (!Array.isArray(rawAbout) || rawAbout.some((v) => typeof v !== "string" || !v.trim()))
    throw new VoiceError("bad-about", "about must be an array of non-empty ids");
  if (draft.kind === "observation") {
    if (!text)
      throw new VoiceError("empty-message", "an observation needs text — why was this asked?");
    if (draft.query !== undefined && (typeof draft.query !== "string" || !draft.query.trim()))
      throw new VoiceError("bad-query", "query must be a non-empty string when present");
    if (draft.urgency !== undefined && draft.urgency !== "now")
      throw new VoiceError("bad-urgency", 'urgency must be "now" when present');
  } else {
    if (!text && !rawAbout.length)
      throw new VoiceError("empty-message", "a voice arrival needs text or about — nothing landed");
    if (draft.query !== undefined || draft.urgency !== undefined)
      throw new VoiceError("bad-query", "query/urgency belong to observations only");
  }
  for (const k of ["from", "via"] as const)
    if (typeof principal[k] !== "string" || !principal[k].trim())
      throw new VoiceError("bad-principal", `"${k}" is required`);
  if (
    principal.from_kind !== undefined &&
    principal.from_kind !== "person" &&
    principal.from_kind !== "agent"
  )
    throw new VoiceError("bad-principal", 'from_kind must be "person" or "agent" when present');

  const about = canonicalizeAbout(root, rawAbout);
  const now = draft.now ?? new Date();
  const title = text
    ? clip(firstLine(text), 120)
    : `(${draft.kind}${about.length ? ` re ${about[0]}` : ""})`;
  const envelope: Envelope & Record<string, unknown> = {
    id: newItemId(opts.idPrefix ?? "voice", now),
    kind: draft.kind,
    title,
    ...(about.length ? { about } : {}),
    ...(draft.kind === "observation" && draft.query ? { query: draft.query.trim() } : {}),
    ...(draft.kind === "observation" && draft.urgency ? { urgency: draft.urgency } : {}),
    from: principal.from,
    ...(principal.from_kind ? { from_kind: principal.from_kind } : {}),
    submitted_via: principal.via,
    received: now.toISOString(),
  };
  const landed = appendSourceInsertion(root, envelope, text);
  try {
    projectSourceInsertion(root, landed.event);
  } catch (error) {
    console.error(`voice: projection failed (the event is safe in the log): ${error}`);
  }
  commitSourceInsertionEvents(root, [landed.path], `voice: ${draft.kind} from ${principal.via}`);
  return {
    id: landed.event.id,
    source_id: landed.event.source_id,
    path: landed.path,
    title,
  };
}

// ── the viewer's read (#521: DirectiveList reads voice insertions) ──────────

/** One voice arrival shaped as the note-messages wire row the viewer
 * already renders (lib/viewTypes.ts messageKind sees `guidance` → a
 * directive row; `outcome` words feed itemStatus): `state` is settledness
 * under the work-view predicate, never a stored file state. */
export interface VoiceMessageRow {
  state: "pending" | "done";
  path: string;
  id: string;
  refs: string[];
  guidance?: string;
  from: string;
  via: string;
  from_kind?: string;
  enqueued?: string;
  outcome?: string;
  kind: VoiceKind;
}

/** Every voice arrival naming one of `keys` (source ids — a note's own
 * envelope id) in its `about`, viewer-shaped. Messages and settledness share
 * one snapshot; failed projection recovery falls back to pending log rows. */
export function voiceMessagesFor(root: string, keys: readonly string[]): VoiceMessageRow[] {
  const wanted = new Set(keys.filter(Boolean));
  if (!wanted.size) return [];
  let snapshot: ReturnType<typeof voiceReadModel>;
  try { snapshot = voiceReadModel(root, wanted); }
  catch {
    // Preserve the viewer's degraded mode when projection recovery fails:
    // voice remains visible, but no settlement is claimed from a partial index.
    snapshot = { voice: readSourceInsertionLog(root).filter(event => isVoiceKind(event.envelope.kind)
      && aboutIds(event.envelope).some(id => wanted.has(id))), settled: new Map() };
  }
  const { voice, settled } = snapshot;
  return voice
    .map((event) => {
      const env = event.envelope;
      const outcome = settled.get(event.id);
      return {
        state: outcome ? ("done" as const) : ("pending" as const),
        path: insertionEventRel(event),
        id: event.id,
        refs: aboutIds(env),
        ...(event.body.trim() ? { guidance: event.body } : {}),
        from: str(env["from"]) ?? event.author.id,
        via: str(env["submitted_via"]) ?? str(env["source"]) ?? "voice",
        ...(str(env["from_kind"]) ? { from_kind: str(env["from_kind"]) } : {}),
        ...(event.received_at ? { enqueued: event.received_at } : {}),
        ...(outcome ? { outcome } : {}),
        kind: env["kind"] as VoiceKind,
      };
    })
    .sort((a, b) => (b.enqueued ?? "").localeCompare(a.enqueued ?? ""));
}
