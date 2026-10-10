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

import { TALK_KINDS } from "./entitySourceMatch";
import type { SourceMetadata } from "./insertionLog";
import { sourceOrigins } from "./sourceOrigin";
import { sourceTime } from "./sourceThreads";

export interface SourceCopies<T extends SourceMetadata = SourceMetadata> {
  /** Best first: text over a stub, then the newest. */
  members: T[];
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

/** What makes a source the same document as another, or nothing when it is
 * talk or mail. */
export function copyKeys(source: Pick<SourceMetadata, "envelope">): string[] {
  const kind = typeof source.envelope.kind === "string" ? source.envelope.kind.trim().toLowerCase() : "";
  if (TALK_KINDS.has(kind) || source.envelope.source === "email") return [];
  return sourceOrigins(source.envelope).flatMap((origin) =>
    origin.kind === "url" ? addressKeys(origin.url) : origin.kind === "file" ? [`file:${origin.sha256}`] : []);
}

/** Every source that has a copy, by insertion id, to its group, best first.
 * `joins` adds keys of the caller's (an entity binding's); `stub` is asked
 * only of a group's members. */
export function sourceCopies<T extends SourceMetadata>(
  sources: readonly T[],
  { joins = new Map(), stub }: { joins?: ReadonlyMap<string, readonly string[]>; stub: (source: T) => boolean },
): Map<string, SourceCopies<T>> {
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    let top = key;
    while (parent.get(top) !== top) top = parent.get(top)!;
    while (key !== top) { const next = parent.get(key)!; parent.set(key, top); key = next; }
    return top;
  };
  const keyed = sources.map((source) => ({ source, keys: [...copyKeys(source), ...(joins.get(source.id) ?? [])] }))
    .filter(({ keys }) => keys.length);
  for (const { keys } of keyed) {
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (const key of keys.slice(1)) parent.set(root(key), root(keys[0]!));
  }
  const groups = new Map<string, T[]>();
  for (const { source, keys } of keyed) {
    const at = root(keys[0]!), group = groups.get(at);
    if (group) group.push(source); else groups.set(at, [source]);
  }
  const out = new Map<string, SourceCopies<T>>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const stubs = new Map(members.map((source) => [source.id, stub(source)]));
    members.sort((a, b) => Number(stubs.get(a.id)) - Number(stubs.get(b.id)) || sourceTime(b) - sourceTime(a) || b.id.localeCompare(a.id));
    const group = { members };
    for (const member of members) out.set(member.id, group);
  }
  return out;
}
