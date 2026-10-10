/** Copies of one document — the same work landed more than once (#206) —
 * grouped on read, as lib/sourceThreads.ts groups mail. Nothing here writes:
 * every insertion and its citations stay as they landed.
 *
 * Supersede (lib/sourceSupersede.ts) is the wrong tool for a copy: every
 * capture gets its own source_id, so a re-capture is a stranger to it, and
 * it hides the older landing's claims where a copy's claims are still true.
 *
 * Exact identity only, no model. Two sources are copies when they share
 *  - their original file (its sha256, lib/sourceOrigin.ts),
 *  - their address, tracking parameters stripped,
 *  - an arXiv id or a DOI in that address, or
 *  - an entity bound to both (lib/entitySourceLog.ts): each IS it.
 * Talk is never a work (lib/entitySourceMatch.ts), and mail is threads'.
 *
 * The best copy leads: one whose text the vault holds over a stub of bytes
 * (the PDF door's own test, lib/text.ts), then the newest.
 */

import { TALK_KINDS, titleForms } from "./entitySourceMatch";
import type { SourceMetadata } from "./insertionLog";
import { copyPairKey, type SourceCopyEvent } from "./sourceCopyLog";
import { sourceOrigins } from "./sourceOrigin";
import { sourceTime } from "./sourceThreads";

export interface SourceCopies<T extends SourceMetadata = SourceMetadata> {
  /** Best first: text over a stub, then the newest. */
  members: T[];
  /** Why two members are copies, when they are linked directly; a pair
   * joined only through a third copy has none. */
  why: (a: string, b: string) => CopyWhy | undefined;
}

const TRACKING = /^(?:utm_\w+|fbclid|gclid|mc_cid|mc_eid|igshid|ref|ref_src)$/i;
const ARXIV_ID = /^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?\/?$/i;
const DOI = /\/(10\.\d{4,9}\/.+?)(?:\.pdf)?\/?$/i;
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

/** One address's keys: itself, normalized, and the paper it names. */
function addressKeys(raw: string): string[] {
  let url: URL;
  try { url = new URL(raw); } catch { return []; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* a malformed escape stays as written */ }
  const params = [...url.searchParams].filter(([name]) => !TRACKING.test(name)).sort(([a], [b]) => a.localeCompare(b));
  const keys = [`url:${host}${path.replace(/\/+$/, "")}${params.length ? `?${new URLSearchParams(params)}` : ""}`];
  const doi = DOI.exec(path)?.[1]?.toLowerCase();
  const arxiv = (/(?:^|\.)arxiv\.org$/.test(host) ? ARXIV_ID.exec(path)?.[1] : undefined) ?? (doi && ARXIV_DOI.exec(doi)?.[1]);
  if (arxiv) keys.push(`arxiv:${arxiv.toLowerCase()}`);
  else if (doi) keys.push(`doi:${doi}`);
  return keys;
}

/** Talk is never a work, and mail is threads'. */
export function isWork(source: Pick<SourceMetadata, "envelope">): boolean {
  const kind = typeof source.envelope.kind === "string" ? source.envelope.kind.trim().toLowerCase() : "";
  return !TALK_KINDS.has(kind) && source.envelope.source !== "email";
}

/** What makes a source the same document as another, or nothing when it is
 * talk or mail. */
export function copyKeys(source: Pick<SourceMetadata, "envelope">): string[] {
  if (!isWork(source)) return [];
  return sourceOrigins(source.envelope).flatMap((origin) =>
    origin.kind === "url" ? addressKeys(origin.url) : origin.kind === "file" ? [`file:${origin.sha256}`] : []);
}

/** Why two sources are copies, strongest first: a person said so, then the
 * same file, the same paper, the same address, an entity bound to both, and
 * last a model's judgment (lib/sourceCopyLog.ts). */
export const COPY_WHY = ["you", "file", "paper", "address", "entity", "judged"] as const;
export type CopyWhy = (typeof COPY_WHY)[number];
const keyWhy = (key: string): CopyWhy =>
  key.startsWith("file:") ? "file" : key.startsWith("url:") ? "address" : key.startsWith("entity:") ? "entity" : "paper";

/** Every source that has a copy, by insertion id, to its group, best first.
 * `joins` adds keys of the caller's (an entity binding's), `pairs` links the
 * caller's (a person's word, a judgment), and `apart` is a person's "not the
 * same", which no key or pair overrides. `stub` is asked only of a group's
 * members. */
export function sourceCopies<T extends SourceMetadata>(
  sources: readonly T[],
  { joins = new Map(), pairs = [], apart = () => false, stub }: {
    joins?: ReadonlyMap<string, readonly string[]>;
    pairs?: readonly (readonly [string, string, CopyWhy])[];
    apart?: (a: string, b: string) => boolean;
    stub: (source: T) => boolean;
  },
): Map<string, SourceCopies<T>> {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const byKey = new Map<string, string[]>();
  for (const source of sources) for (const key of [...copyKeys(source), ...(joins.get(source.id) ?? [])]) {
    const ids = byKey.get(key);
    if (ids) ids.push(source.id); else byKey.set(key, [source.id]);
  }
  const links = new Map<string, CopyWhy>();
  const link = (a: string, b: string, why: CopyWhy): void => {
    if (a === b || !byId.has(a) || !byId.has(b) || apart(a, b)) return;
    const key = copyPairKey(a, b), held = links.get(key);
    if (!held || COPY_WHY.indexOf(why) < COPY_WHY.indexOf(held)) links.set(key, why);
  };
  for (const [key, ids] of byKey)
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) link(ids[i]!, ids[j]!, keyWhy(key));
  for (const [a, b, why] of pairs) link(a, b, why);

  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let top = id;
    while (parent.get(top) !== top) top = parent.get(top)!;
    while (id !== top) { const next = parent.get(id)!; parent.set(id, top); id = next; }
    return top;
  };
  const linked = [...links.keys()].map((key) => key.split("|") as [string, string]);
  for (const [a, b] of linked) { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); }
  for (const [a, b] of linked) parent.set(root(a), root(b));
  const groups = new Map<string, T[]>();
  for (const id of parent.keys()) {
    const at = root(id), group = groups.get(at);
    if (group) group.push(byId.get(id)!); else groups.set(at, [byId.get(id)!]);
  }
  const why = (a: string, b: string): CopyWhy | undefined => links.get(copyPairKey(a, b));
  const out = new Map<string, SourceCopies<T>>();
  for (const members of groups.values()) {
    const stubs = new Map(members.map((source) => [source.id, stub(source)]));
    members.sort((a, b) => Number(stubs.get(a.id)) - Number(stubs.get(b.id)) || sourceTime(b) - sourceTime(a) || b.id.localeCompare(a.id));
    const group = { members, why };
    for (const member of members) out.set(member.id, group);
  }
  return out;
}

// ── the fuzzy half: candidates, judgments, a person's word ─────────────────
// Candidates are works whose titles name each other the way an entity's
// label names its source (lib/entitySourceMatch.ts): the same words once an
// extension, a parenthetical or a "| Publisher" tail is off, or one with its
// subtitle dropped. A model scores each (lib/sourceCopyJudge.ts); at or above
// the cut-off it is a copy, and below it, above the floor or not yet judged,
// it is asked. A person's word settles a pair for good, and their answers to
// judged pairs fit the cut-off.

/** Until a person has answered this many judged pairs, the cut-off is the default. */
export const DEFAULT_CUTOFF = 0.8;
export const MIN_LABELS = 5;
/** Never merge on a coin flip, whatever the answers say. */
const LOWEST_CUTOFF = 0.5;
/** Below this, a judged pair is two documents and is not asked. */
export const PROPOSE_FLOOR = 0.3;
/** A title shared by more works than this is generic ("Sign in to your account"), not a work's. */
const CROWD = 8;

export interface CopyRecord {
  /** A person's latest word per pair. */
  declared: Map<string, boolean>;
  /** A model's latest score per pair. */
  judged: Map<string, { score: number; model: string }>;
}

/** The log, folded: latest per pair and kind. */
export function foldCopyEvents(events: readonly SourceCopyEvent[]): CopyRecord {
  const out: CopyRecord = { declared: new Map(), judged: new Map() };
  const byTime = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const event of byTime) {
    const key = copyPairKey(...event.pair);
    if (event.event === "source.copies-declared") out.declared.set(key, event.same);
    else out.judged.set(key, { score: event.score, model: event.author.id });
  }
  return out;
}

/** The score at and above which a judged pair is a copy: the one that best
 * agrees with a person's answers to judged pairs (the higher, on a tie). */
export function copyCutoff({ declared, judged }: CopyRecord): number {
  const labels = [...declared].flatMap(([key, same]) => {
    const j = judged.get(key);
    return j ? [{ score: j.score, same }] : [];
  });
  if (labels.length < MIN_LABELS) return DEFAULT_CUTOFF;
  const errors = (t: number): number => labels.filter((l) => (l.same ? l.score < t : l.score >= t)).length;
  const lines = [DEFAULT_CUTOFF, ...labels.flatMap((l) => [l.score, l.score + 1e-6])].filter((t) => t >= LOWEST_CUTOFF && t <= 1);
  return lines.reduce((best, t) => (errors(t) < errors(best) || (errors(t) === errors(best) && t > best) ? t : best), DEFAULT_CUTOFF);
}

const sameTitle = (a: readonly string[][], b: readonly string[][]): boolean => a.some((x) => b.some((y) => {
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (!short.every((word, i) => long[i] === word)) return false;
  return short.length === long.length || (short.length >= 5 && short.length >= 0.6 * long.length);
}));

/** Pairs of works whose titles name each other, ascending, once each. */
export function copyCandidates(sources: readonly SourceMetadata[]): [string, string][] {
  const forms = new Map<string, string[][]>();
  const buckets = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!isWork(source)) continue;
    const held = titleForms(source.title).filter((words) => words.length >= 3);
    if (!held.length) continue;
    forms.set(source.id, held);
    for (const words of held) {
      const key = words.slice(0, 3).join(" "), ids = buckets.get(key);
      if (ids) ids.add(source.id); else buckets.set(key, new Set([source.id]));
    }
  }
  const out = new Map<string, [string, string]>();
  for (const ids of buckets.values()) {
    if (ids.size < 2 || ids.size > CROWD) continue;
    const list = [...ids];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i]!, list[j]!].sort() as [string, string];
      if (sameTitle(forms.get(a)!, forms.get(b)!)) out.set(copyPairKey(a, b), [a, b]);
    }
  }
  return [...out.values()];
}

