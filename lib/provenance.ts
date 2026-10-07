/** provenance.ts — where what an agent reads came from, and the one fence
 * around text from outside the person.
 *
 * Every item a reader tool hands an agent carries a `Provenance`
 * (lib/agentReads.ts applies it): its origin `kind`, whether it is
 * `trusted`, its sender, when it arrived or was last updated, and its path
 * or ref. `trusted` is true only for what the person wrote, or what the
 * vault's passes wrote from nothing else:
 *
 * - a source, when a door only the person uses stamped it as theirs from a
 *   verified credential (`from_kind: person` through the viewer, their
 *   device token, the CLI or the identity declaration; never a poller, whose
 *   `from_kind: person` names the sender) and it is their own words: a
 *   directive, request, observation, identity declaration, note, idea or
 *   dream that carries no url and no file;
 * - an entity dossier, when every source each of its claims cites is trusted;
 * - memory, unless the memory pass stamped claims in it as drawn from outside
 *   (lib/memoryProvenance.ts); those claims are fenced one by one;
 * - nothing else: mail, meeting notes, feeds, clips, files, agent drops and
 *   transcripts, legacy dossiers and run journals are untrusted.
 *
 * Untrusted text is fenced in `<untrusted-data …>` with its provenance as
 * attributes, and nothing inside can close the fence. */
import { insertionEventRel, sourceMoment, type SourceMetadata } from "./insertionLog";

export type OriginKind = "memory" | "entity" | "note" | "source" | "email" | "granola" | "rss" | "web" | "drop" | "agent";

export interface Provenance {
  kind: OriginKind;
  trusted: boolean;
  /** Who it is from, as the record names them: a sender, an agent, a feed. */
  from?: string;
  /** When it arrived: a source's own moment, a message's receipt. */
  received?: string;
  /** When a curated note last changed. */
  updated?: string;
  /** Vault-relative path a reader can open it at. */
  path?: string;
  /** A live item's opaque ref. */
  ref?: string;
}

const FENCE = /<(\/?untrusted-data)/giu;
const attr = (v: string) => v.replace(/\s+/gu, " ").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Text that cannot open or close a fence. */
export const defang = (text: string): string => text.replace(FENCE, "&lt;$1");

/** One piece of untrusted material, fenced: where it came from as
 * attributes, and nothing inside can close the fence. `inline` keeps it on
 * one line, for a claim inside a list. */
export function fenceUntrusted(about: Record<string, string | undefined>, body: string, inline = false): string {
  const attrs = Object.entries(about).filter((e): e is [string, string] => !!e[1]).map(([k, v]) => ` ${k}="${attr(v)}"`).join("");
  const nl = inline ? "" : "\n";
  return `<untrusted-data${attrs}>${nl}${defang(body)}${nl}</untrusted-data>`;
}

/** A provenance as fence attributes. */
export const fenceAbout = (p: Provenance, title?: string): Record<string, string | undefined> =>
  ({ kind: p.kind, from: p.from, title, received: p.received, updated: p.updated, path: p.path });

const word = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Doors only the person uses, where `from_kind: person` is stamped from their own verified credential. */
const OWNER_DOORS = new Set(["web", "api", "cli", "user-bootstrap"]);
/** Kinds that are the person's own words rather than material they passed along. */
const OWN_WORDS = new Set(["directive", "request", "observation", "identity-declaration", "note", "idea", "dream"]);

/** The trust rule for one source's envelope (or a markdown note's frontmatter). */
export function sourceTrusted(envelope: Record<string, unknown>): boolean {
  const source = word(envelope["source"]);
  return envelope["from_kind"] === "person"
    && (source === undefined || OWNER_DOORS.has(source))
    && OWN_WORDS.has(word(envelope["kind"]) ?? "")
    && !word(envelope["url"]) && !word(envelope["filename"])
    && !(Array.isArray(envelope["attachments"]) && envelope["attachments"].length);
}

/** Where a source came from, as one of the origin kinds. */
export function originOf(envelope: Record<string, unknown>): OriginKind {
  const source = word(envelope["source"]), kind = word(envelope["kind"]);
  if (source === "email" || kind === "email") return "email";
  if (source === "granola") return "granola";
  if (source === "rss") return "rss";
  if (envelope["from_kind"] === "agent" || source === "mcp" || source === "pilot" || source === "agent-chat") return "agent";
  if (kind === "web-clip" || kind === "pdf-import" || word(envelope["url"])) return "web";
  if (envelope["from_kind"] === "person" && (source === undefined || OWNER_DOORS.has(source))) return "drop";
  return "source";
}

/** A sender as the record names them, kept short. */
export const sender = (v: unknown): string | undefined => word(v)?.replace(/\s+/gu, " ").slice(0, 120);

/** A source insertion's provenance. */
export function sourceProvenance(s: SourceMetadata, path = insertionEventRel(s)): Provenance {
  const from = sender(s.envelope["from"]), received = sourceMoment(s);
  return { kind: originOf(s.envelope), trusted: sourceTrusted(s.envelope), ...(from ? { from } : {}), ...(received ? { received } : {}), path };
}
