/** Pure link syntax and text transformations. No filesystem or record readers. */

// The |label class admits newlines: the editor hard-wraps prose, so a
// link's label routinely spans a line break — a per-line scan (or a \n in
// the label class) silently drops those links, and with them their graph
// edges. Target and #sub stay single-line; they are slugs and never wrap.
// It also admits single brackets — a clipped paper's title is its label,
// and titles like "[PLDI'26] Compiling…" are routine — so only `]]`
// closes; a lone `]` can never swallow a following link across it.
export const LINK_RE = /\[\[([^\][|#^\n]+)([#^][^\][|\n]*)?(?:\|((?:[^\]]|\](?!\]))+))?\]\]/g;

// A markdown inline link: [label](href), optional "title", and the
// leading ! that would make it an image. The label may wrap (the editor
// hard-wraps prose); the href never does.
export const MD_LINK_RE = /(!?)\[([^\][]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** A markdown link that points at a note — the shape wikilinks are for. */
export type MdLink = {
  file: string; // vault-relative path of the note containing the link
  line: number; // 1-indexed
  href: string; // the target as written
  label: string; // the display text
  resolved: string; // the vault-relative note it points at
};

/** Collapse ./ and ../ without touching the filesystem. */
const normalizeRel = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};

/** lowercased vault-relative path → the path as it really is on disk. */
export const pathIndex = (paths: string[]): Map<string, string> =>
  new Map(paths.map((p) => [p.toLowerCase(), p]));

/** The note a markdown link points at, or null when it points anywhere
 * else — a URL, a bare anchor, an asset, a file this vault doesn't have.
 * Relative to the LINKING NOTE'S directory first, which is what
 * `[FRI work](fri-work.md)` means inside memory/, then from the root. */
export function mdTarget(file: string, href: string, known: Map<string, string>): string | null {
  const h = href.trim().split("#")[0]!.split("?")[0]!;
  if (!h || h.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // scheme or protocol-relative
  if (!h.toLowerCase().endsWith(".md")) return null;
  const dir = file.split("/").slice(0, -1).join("/");
  for (const cand of [normalizeRel(dir ? `${dir}/${h}` : h), normalizeRel(h)]) {
    const hit = known.get(cand.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** The note text with fenced code lines blanked to spaces, so link scans
 * can run over the whole text — wrapped labels included — and still skip
 * code. LENGTH-PRESERVING, not just line-preserving: a match index in the
 * masked text is the same index in the original, which is what lets
 * migrateLinks splice replacements back into the real bytes. */
export function maskFences(text: string): string {
  if (!text.includes("```") && !text.includes("~~~")) return text;
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return " ".repeat(line.length);
      }
      return fenced ? " ".repeat(line.length) : line;
    })
    .join("\n");
}

/** One `[[...]]` match, unmasked position included so a caller can splice
 * a replacement back into the source (as excerpt() below does). */
export type WikilinkMatch = {
  target: string;
  sub: string;
  label: string | null;
  index: number;
  raw: string;
};

/** Every wikilink in a blob of text — target, #sub/^block anchor, and
 * |label teased apart the one way the vault means them (LINK_RE above).
 * No file, no fence masking, no line numbers: the parse itself, for
 * callers that read the text some other way. #257: this is the ONE
 * grammar lib/api.ts's link-chip list and its excerpt renderer both read
 * through now, in place of their own hand-rolled copies — those swallowed
 * an anchor into the target and never resolved it. */
export function parseWikilinks(text: string): WikilinkMatch[] {
  const out: WikilinkMatch[] = [];
  for (const m of text.matchAll(LINK_RE))
    out.push({
      target: m[1]!.trim(),
      sub: m[2] ?? "",
      label: m[3]?.replace(/\s+/g, " ").trim() ?? null,
      index: m.index!,
      raw: m[0],
    });
  return out;
}

/** A wikilink's plain-text stand-in — the label if written, else the
 * target with its anchor, so `[[page#section]]` reads as "page#section"
 * rather than silently dropping the part after `#`. */
export const wikilinkText = (link: WikilinkMatch): string =>
  link.label ?? `${link.target}${link.sub}`;

/** The splice loop every link rewriter shares (#642): scan the fence-masked
 * text with `re`, ask `decide` for each match's replacement — null leaves
 * the link as written — and splice answers into the ORIGINAL bytes
 * (maskFences is length-preserving, so a mask index lands on the real
 * text). `touched` is true iff something was spliced. */
export function rewriteLinks(
  text: string,
  re: RegExp,
  decide: (m: RegExpExecArray) => string | null
): { text: string; touched: boolean } {
  const masked = maskFences(text);
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(re)) {
    const replacement = decide(m);
    if (replacement === null) continue;
    out += text.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
  }
  return last ? { text: out + text.slice(last), touched: true } : { text, touched: false };
}

