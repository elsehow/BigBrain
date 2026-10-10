/**
 * sourceOrigin.ts — where a source LIVES outside the vault, read off its
 * envelope. A clipped page's origin is the page; a Granola note's is the
 * note on granola.ai; a dropped PDF's is the PDF itself, kept whole in the
 * CAS beside its extraction. The note view offers to open the original.
 *
 * One ordered list of rules, first hit wins; a new source kind that wants
 * its own notion of "the original" adds a rule, not a branch in a view.
 * The rules read the envelope's established fields only — `url`, which
 * the extension, Granola and the plugin's clips all stamp, and
 * `attachments`, lib/envelope.ts's AttachmentRef — never a new one
 * (no schema growth on the logs).
 *
 * Pure: no filesystem, no process. Opening is lib/sourceOpen.ts's.
 */

import type { AttachmentRef } from "./envelope";
import { scalar } from "./text";

export type SourceOrigin =
  /** A page — opened in the person's browser. */
  | { kind: "url"; url: string }
  /** The original file, by its CAS address — opened by the OS in whatever
   * reads that kind of file. */
  | { kind: "file"; name: string; sha256: string; mime: string; bytes: number }
  /** Stored text, opened as a Markdown copy when there is no external original. */
  | { kind: "note"; name: string };

type Rule = (envelope: Record<string, unknown>) => SourceOrigin | null;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** `url:` — a web clip (extension or plugin), a YouTube page, a Granola
 * note's own link. Only a web address counts: the browser is the opener,
 * and it is handed nothing it could not have fetched itself. */
const page: Rule = (envelope) => {
  const raw = scalar(envelope["url"])?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? { kind: "url", url: u.href } : null;
  } catch {
    return null;
  }
};

/** The first attachment — a drop's original (the PDF beside its text layer,
 * the .docx the reference summarises), an agent-chat's transcript. The
 * reference body links it as `blob:<sha256>`; the sha256 IS the address. */
const original: Rule = (envelope) => {
  const list = envelope["attachments"];
  if (!Array.isArray(list)) return null;
  const a = list[0] as Partial<AttachmentRef> | undefined;
  if (!a || typeof a.sha256 !== "string" || !SHA256_RE.test(a.sha256)) return null;
  const name = typeof a.name === "string" && a.name.trim() ? a.name.trim() : a.sha256;
  return {
    kind: "file",
    name,
    sha256: a.sha256,
    mime: typeof a.mime === "string" && a.mime ? a.mime : "application/octet-stream",
    bytes: typeof a.bytes === "number" && Number.isFinite(a.bytes) ? a.bytes : 0,
  };
};

/** In order: a page beats a file, because a clip that carried both (a
 * page saved with its PDF) is still a clip of the page. */
const RULES: readonly Rule[] = [page, original];

/** Every original the envelope names, in the rules' order: its page, then
 * its file. Copies of one document pool theirs (lib/sourceCopies.ts). */
export function sourceOrigins(envelope: Record<string, unknown>): SourceOrigin[] {
  return RULES.flatMap((rule) => rule(envelope) ?? []);
}

/** Prefer the external original; otherwise offer the stored body as
 * Markdown when the caller supplies the source. Empty sources have no target. */
export function sourceOrigin(envelope: Record<string, unknown>, note?: { title: string; body: string }): SourceOrigin | null {
  const [hit] = sourceOrigins(envelope);
  if (hit) return hit;
  if (note?.body.trim()) return { kind: "note", name: `${note.title.replace(/\.md$/i, "").slice(0, 60) || "Note"}.md` };
  return null;
}
