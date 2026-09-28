/**
 * envelope.ts — the one typed frontmatter parse/serialize module. Every item
 * (inbox arrival, request, filed note) carries a YAML frontmatter block; this
 * replaced the ~8 ad-hoc regexes the pre-envelope editor and server
 * carried with a single parser built on the `yaml` package.
 *
 * Side-effect-free at import, so this can be imported from anywhere —
 * including a process with no vault.
 */

import { parse, stringify } from "yaml";

/** A binary payload in the CAS (`.blobs/sha256/<ab>/<hash>`, lib/blobs.ts),
 * referenced from a reference's envelope. The body links it with a
 * `blob:<sha256>` target — `[name](blob:<hex>)`, images `![name](blob:<hex>)`
 * — the ONE blob-link representation; resolvers (the viewer's /api/file)
 * translate it, and nothing else ever encodes a blob
 * location into item text. */
export interface AttachmentRef {
  name: string;
  sha256: string;
  bytes: number;
  mime: string;
}

/** A source-declared actor in an evidence item. `raw` preserves precisely what
 * the integration received; the normalized name/emails are mechanical
 * projections, never model-inferred relationships. */
export interface Participant {
  raw: string;
  name?: string;
  emails?: string[];
  role?: string;
}

/** The de-facto envelope contract: fields stamped or read by the runner, the
 * intake API, and the web viewer. Unknown keys pass through untouched — this
 * is a superset view of whatever frontmatter a note happens to carry, not a
 * strict schema. */
export interface Envelope {
  id?: string;
  source?: string;
  kind?: string;
  /** The item's substrate type (drop-zone pivot, cut 3 —
   * docs/plans/2026-08-03-drop-zone-bigbrain.md): a fact of provenance
   * DECLARED by the delivering integration (granola knows it delivers a
   * transcript the same way it knows its own `source:`), validated and
   * defaulted by the landing — never guessed by a model. One of
   * ITEM_TYPES, tolerant by the module's standing rule: an unrecognized
   * value passes through and renders as-is. `entity` is derived-only by
   * convention — stamped by the synthesis that produces a dossier, not
   * declarable meaningfully at a front door (a dropped "entity" is
   * material for the editor to merge, not an entity view). Distinct from
   * `kind:`, which historically mixes substrate ("meeting", "email"),
   * queue addressing ("request"), and derived forms ("entity") — legacy
   * kinds map into types via FLAVOR_TO_TYPE at landing. */
  type?: ItemType | (string & {});
  /** Open descriptive vocabulary riding beside the strong type (transcript,
   * paper, dream, …) — never behavior-bearing, never validated beyond
   * being non-empty strings. Declared by integrations or people; the landing
   * landing folds flavor words into it (normalizeType). */
  tags?: string[];
  /** The reference's ONE category (Nick's rule, 2026-08-05): every
   * reference carries exactly one — an exclusive partition of the record,
   * unlike `tags` (open, plural, descriptive). Stamped mechanically at
   * landing (normalizeType: the front door's flavor word, falling back to first
   * tag → source → "drop"), reassignable afterward only by the editor,
   * judged against the live census (never coin a near-duplicate). The
   * vocabulary is EMERGENT-OPEN — the deliberate opposite of ENTITY_TYPES'
   * closed set: the stream is heterogeneous and unknowable in advance, so
   * words are minted from the record, not legislated here. checkTypes
   * enforces only the cardinality: exactly one, never empty. Entities
   * carry `entity_type` instead — never this. */
  category?: string;
  title?: string;
  /** When the thing described HAPPENED — true-in-world time, declared by
   * whoever knows (a meeting's scheduled start, an email's Date). Its pair
   * is `received` below, stamped at landing: when the vault LEARNED it. The
   * two together make every arrival bi-temporal at no cost, which is what
   * lets an as-of query ("what did the record know last Tuesday?") be
   * answered by replay rather than by a shadow store (#46). */
  date?: string;
  aliases?: string[];
  /** The retired editor's flag for the vault's own USER (issue #51). No
   * prompt or view reads it any more (#683): who the vault is about is the
   * identity declaration (lib/userIdentity.ts), and `bigbrain whoami
   * --adopt-dossier` folds what a flagged dossier holds into it. The file
   * stays — it is the person's, and a vault is never migrated. */
  human_user?: boolean;
  from?: string;
  from_kind?: string;
  submitted_by?: string;
  submitted_via?: string;
  received?: string;
  fetched?: string;
  sha256?: string;
  /** The citation contract (phase 3): reference ids (or vault-relative
   * source paths) a curated note draws on. Required forward-only — new and
   * edited vault notes cite; pre-existing notes without `sources` are
   * grandfathered, never flagged (see lib/links.ts checkSources). */
  sources?: string[];
  /** `kind: entity` companion (phase 3, recognition only — no extraction
   * pipeline; the `file`/`synthesize` verbs create and maintain these by
   * existing convention, the engine merely recognizes the kind). One of
   * ENTITY_TYPES — the SSOT below — but tolerant by the same rule as the
   * rest of this module: an unrecognized value is never rejected at parse
   * or render (graph node, feed row, search hit show it as-is); checkTypes
   * reports it as a violation instead. */
  entity_type?: EntityType | (string & {});
  attachments?: AttachmentRef[];
  participants?: Participant[];
  filed?: string;
  triage_run?: string;
  pass?: string;
  /** ── arrival identity (#46) ──────────────────────────────────────────
   * Source identity and ordering. The split is: INTEGRATIONS OWN THE
   * SEMANTICS, THE ENGINE OWNS THE VOCABULARY. Source knowledge (iCal
   * `SEQUENCE` orders revisions; a session uuid names a conversation; a
   * `Message-ID` names an email) dies at the integration boundary,
   * translated into these four fields, which everything downstream
   * consumes source-agnostically. Nobody builds a per-source shadow store
   * to answer "is this the same thing I saw before?".
   *
   * All four are OPTIONAL and purely additive — an integration that stamps
   * none of them behaves exactly as it did before. They are declared, like
   * `type:` and `source:`, by the side that already knows: stamping them is
   * mechanical projection of what the source said, never judgment, and no
   * model runs at any door (design principle §3).
   *
   * `stream` — which source/account this came from. Should be the most
   * durable identity the integration can cheaply establish, because a
   * fragile one splits ONE history across two streams and merging them
   * afterward is far more expensive than stamping them right. The worked
   * example is a working directory: prefer `git remote get-url origin`
   * over `machine + path`, since the same repo cloned on two machines — or
   * moved on one — reads as two unrelated streams under a path. Fall back
   * to `machine + path` only for remoteless dirs.
   */
  stream?: string;
  /** Stable object identity WITHIN the stream — a calendar event id, a
   * session uuid, a `Message-ID`. Two arrivals sharing (stream, key) are
   * the same object: revisions of one event, or chapters of one
   * conversation. The engine never interprets the string. */
  key?: string;
  /** The SOURCE's own ordering for that key — iCal `SEQUENCE`, a transcript
   * line range, a message timestamp. Whatever the source counts in, hence
   * string-or-number: `12`, `"1-420"`, an ISO stamp. Compared only against
   * other `seq` values from the same stream, and never by this module. */
  seq?: string | number;
  /** A prior reference id this event REPLACES, when the integration knows
   * it (a re-clip of a page already clipped). Absent is the normal case —
   * doors that would have to guess leave it unset and the editor decides. */
  supersedes?: string;
  /** What this arrival is ABOUT — source ids it points at. Voice arrivals
   * (#521: kind directive/request/observation, lib/voice.ts) land it as a
   * canonicalized string[]; the web drop zone's legacy stamp was a single
   * string. Read it tolerantly via lib/voice.ts's aboutIds, never raw. */
  about?: string | string[];
  [key: string]: unknown;
}

/** THE entity-type vocabulary — the single source of truth (ruled
 * 2026-08-05; the old mockup set person|place|document|thread had drifted
 * from the editor prompt's real one). Nothing else may restate it: the
 * editor prompt receives it as {{entity_types}} at render (worker.ts
 * buildPrompt), checkTypes (lib/links.ts) reports dossiers outside it, and
 * every display surface stays a tolerant renderer of whatever the file
 * says — enforcement lives in the check, never in a renderer. Extend the
 * vocabulary HERE and every consumer follows. */
export const ENTITY_TYPES = ["person", "org", "project", "place"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** The governed substrate-type vocabulary (see Envelope.type) — CLOSED and
 * STRONG (ruled 2026-08-03; `note` retired 2026-08-05): a type earns
 * existence only if the engine behaves differently because of it.
 *   reference — a record the vault keeps; immutable; cited, never
 *               rewritten (transcripts, papers, emails, clips, AND the
 *               user's own written words — a dropped idea is record too)
 *   entity    — a maintained dossier with a referent; merged + back-indexed
 * The vault's third type, `memory`, never rides an envelope: memory/ is
 * derived by the memory pass and typed by its tree, not by frontmatter.
 * Everything finer (paper vs podcast vs dream) is a TAG — open,
 * descriptive, ungoverned, dispatch-free.
 *
 * Every content arrival IS a reference — that's why it can be the default
 * without guessing: entities are created only by the editor, memory only
 * by the memory pass, and the machinery kinds (`kind: request`,
 * observations) are ROUTED by intake before typing ever happens — they are
 * destinations, not types, and never land in the record. `note` died
 * because it was a third bucket for an ambiguity that doesn't exist; it
 * survives below as a flavor word so legacy items re-normalize cleanly. */
const ITEM_TYPES = ["reference", "entity"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Flavor words seen in the wild — legacy `kind:` values, old-vault `type:`
 * frontmatter — mapped to their strong type; the word itself survives as a
 * tag. A mechanical table, not inference: every row encodes what the
 * delivering side already meant. Words in NO row map to `reference` + the
 * word as a tag (the only arrival type, information kept, nothing guessed). */
export const FLAVOR_TO_TYPE: Record<string, ItemType> = {
  // things someone wrote into the vault — record, same as any arrival
  // (`note` itself is the retired type: legacy stamped items re-normalize)
  note: "reference",
  idea: "reference",
  dream: "reference",
  "meeting-dossier": "reference", // a note about a meeting, linking its reference + entities
  // external records the vault keeps
  meeting: "reference",
  transcript: "reference",
  email: "reference",
  "web-clip": "reference",
  paper: "reference",
  "working-paper": "reference",
  article: "reference",
  post: "reference",
  review: "reference",
  analysis: "reference",
  image: "reference",
  podcast: "reference",
  code: "reference",
  dataset: "reference",
  "legal-document": "reference",
};

const cleanTags = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim())
    : [];

/** The item's strong type + tags + one category, normalized from whatever
 * the envelope carries: a declared ITEM_TYPES value is kept; a flavor word
 * (declared `type:` or legacy `kind:`) maps through FLAVOR_TO_TYPE and
 * joins the tags; an unknown word defaults to `reference` and joins the
 * tags; nothing declared is a plain `reference` — every content arrival is
 * record (routing kinds never reach this: intake diverts them first).
 * Declared `tags:` always carry through. The category resolves declared →
 * flavor word → first tag → source → "drop" — a declared value winning
 * means the editor's reassignment survives every re-normalization. Pure
 * read — the landing stamps the result (file-time enforcement). */
export function normalizeType(env: Envelope): { type: ItemType; tags: string[]; category: string } {
  const tags = cleanTags(env.tags);
  const addTag = (w: string): void => {
    if (!tags.includes(w)) tags.push(w);
  };
  const raw =
    (typeof env.type === "string" && env.type.trim()) ||
    (typeof env.kind === "string" && env.kind.trim()) ||
    "";
  let type: ItemType = "reference";
  if ((ITEM_TYPES as readonly string[]).includes(raw)) type = raw as ItemType;
  else if (raw && FLAVOR_TO_TYPE[raw]) {
    type = FLAVOR_TO_TYPE[raw];
    addTag(raw);
  } else if (raw) addTag(raw); // unknown word: strong default `reference`, word kept as tag
  // the ONE category (see Envelope.category) — checked in resolution order,
  // reading kind before type so a landed file (strong type stamped, kind
  // preserved) resolves the same word it landed with
  const flavor = [env.kind, env.type].find(
    (w): w is string =>
      typeof w === "string" && !!w.trim() && !(ITEM_TYPES as readonly string[]).includes(w.trim())
  );
  const category =
    (typeof env.category === "string" && env.category.trim()) ||
    flavor?.trim() ||
    tags[0] ||
    (typeof env.source === "string" && env.source.trim()) ||
    "drop";
  return { type, tags, category };
}

/** normalizeType's type alone — for readers that only band or group. */
export function resolveType(env: Envelope): ItemType {
  return normalizeType(env).type;
}

const OPEN = "---\n";

/** A fresh item id, `<prefix>-YYYY-MM-DDTHH-MM-SS-<6 rand>` — the one id
 * shape every front door stamps (HTTP prefix `api`, ssh prefix `ssh`).
 * Identity is required downstream: the reference path, move-detection, receipts
 * all key on it. */
export function newItemId(prefix: string, now = new Date()): string {
  const ts = now.toISOString().slice(0, 19).replace(/[:]/g, "-");
  return `${prefix}-${ts}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse a note's raw text into its envelope and body. Tolerant by design —
 * missing frontmatter, an unterminated block, or YAML that doesn't parse to
 * a mapping all yield an empty envelope and the full original text as body.
 * Never throws.
 *
 * Fence detection is done by hand rather than one regex: a single `\n---\n?`
 * only ever swallows ONE trailing newline, which would leave a spurious
 * leading blank line in `body` whenever a note follows the usual convention
 * of a blank separator line after the closing fence (see serializeEnvelope).
 * Consuming the fence's own newline and one optional blank line explicitly
 * keeps parse/serialize an exact round-trip. */
export function parseEnvelope(raw: string): { envelope: Envelope; body: string } {
  if (!raw.startsWith(OPEN)) return { envelope: {}, body: raw };
  const rest = raw.slice(OPEN.length);
  const closeAt = rest.indexOf("\n---");
  if (closeAt === -1) return { envelope: {}, body: raw }; // no closing fence

  const fmText = rest.slice(0, closeAt);
  let after = rest.slice(closeAt + "\n---".length);
  if (after.startsWith("\n")) after = after.slice(1); // the fence line's own newline
  if (after.startsWith("\n")) after = after.slice(1); // one blank separator line, if present

  let parsed: unknown;
  try {
    parsed = parse(fmText);
  } catch {
    return { envelope: {}, body: raw }; // malformed YAML — don't trust the split either
  }
  if (parsed == null) return { envelope: {}, body: after }; // empty block: valid, just empty
  if (typeof parsed !== "object" || Array.isArray(parsed)) return { envelope: {}, body: raw }; // not a mapping
  return { envelope: parsed as Envelope, body: after };
}

/** Serialize an envelope + body back into note text. An envelope with no
 * keys produces no frontmatter block at all (the round-trip inverse of the
 * empty case above) — never `---\n{}\n---`. Key order follows the object's
 * own enumeration order (JS preserves string-key insertion order, and so
 * does `yaml`'s parser), so passthrough keys keep their original position. */
export function serializeEnvelope(envelope: Envelope, body: string): string {
  const keys = Object.keys(envelope);
  if (!keys.length) return body;
  return `---\n${stringify(envelope)}---\n\n${body}`;
}

/** `kind: entity` — a first-class person/place/document/thread note (phase
 * 3: recognition only, no extraction pipeline — see Envelope.entity_type). */
export function isEntity(env: Envelope): boolean {
  return env.kind === "entity" || env.type === "entity";
}

// ── line-regex sniffs — the pre-envelope ad-hoc patterns, kept verbatim as
// the shared tolerant path. Dropped items and hand-written requests aren't
// guaranteed valid YAML, and a line regex still reads a well-formed line
// inside a block the whole-YAML parse rejects. Every site that needs that
// tolerance shares these — one predicate per test, never two drifting
// copies. (Typed `isRequest`/`isDeepPass` successors stood above until the
// 2026-08-30 dead-code pass; nothing had moved onto them.)

/** `kind: request` sniffed off raw frontmatter text. */
export function sniffRequest(fm: string): boolean {
  return /^kind:\s*request\s*$/m.test(fm);
}

/** `pass: deep` sniffed off raw frontmatter text — the editor era's
 * queue-split test, kept for parsing legacy items. */
export function sniffDeepPass(fm: string): boolean {
  return /^pass:\s*deep\s*$/m.test(fm);
}

/** One `key: value` line read off raw frontmatter text, optional quotes —
 * web/server.ts's old key() closure, verbatim. */
function sniffFmKey(fm: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m").exec(fm)?.[1]?.trim();
}

/** A best-effort envelope sniffed line-wise for the given keys. */
function sniffEnvelope(fm: string, keys: string[]): Envelope {
  const env: Envelope = {};
  for (const k of keys) {
    const v = sniffFmKey(fm, k);
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** parseEnvelope with a line-wise fallback: when the whole-block parse
 * yields nothing (malformed YAML somewhere in the block), sniff just the
 * given keys off the block text — one bad line must not blind the
 * well-formed lines around it. Model-edited notes do produce such blocks;
 * the viewer's provenance/dating reads go through this. */
export function envelopeOrSniff(raw: string, keys: string[]): Envelope {
  const { envelope } = parseEnvelope(raw);
  if (Object.keys(envelope).length) return envelope;
  return sniffEnvelope(/^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "", keys);
}
