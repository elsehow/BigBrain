/**
 * vaultRead.ts — the markdown-read core both HTTP doors stand on (#259):
 * one tree walk, one parsed-note view, one prose excerpt. Extracted from
 * lib/api.ts, whose /v1/note shape pinned the behavior
 * (test/api.test.ts); web/server.ts's listNotes/countMd walk the same way
 * with their own options. Near-pure: everything reads under `root` and
 * nothing writes, which is exactly what a temp-dir vault gives a test.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { parseEnvelope, type Envelope } from "./envelope";
import { parseWikilinks, wikilinkText } from "./linkSyntax";

export interface WalkOptions {
  /** Stop after this many files — a defensive ceiling on tree walks. */
  cap?: number;
  /** Directory descents allowed below each tree (0 = that tree's own files
   * only). Unlimited when absent. */
  maxDepth?: number;
  /** Skip dot-entries (files and directories alike) — the viewer's rule. */
  skipDotted?: boolean;
}

/** Every .md under `trees` (vault-relative, tree order preserved, readdir
 * order within). Missing trees are skipped; the walk never leaves `root`
 * because it only descends readdir children of the named trees. A tree of
 * "" walks `root` itself — the counting caller's spelling. */
export function walkMarkdown(
  root: string,
  trees: readonly string[],
  opts: WalkOptions = {}
): string[] {
  const cap = opts.cap ?? Infinity;
  const maxDepth = opts.maxDepth ?? Infinity;
  const out: string[] = [];
  const visit = (rel: string, depth: number): void => {
    if (out.length >= cap) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (opts.skipDotted && e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth) visit(child, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".md")) out.push(child);
    }
  };
  for (const t of trees) visit(t, 0);
  return out;
}

export interface NoteView {
  rel: string;
  mtime: string;
  envelope: Envelope;
  body: string;
  title: string;
}

/** One parsed note, or null when unreadable. Title precedence: frontmatter →
 * first `# `heading → basename. */
export function noteView(root: string, rel: string): NoteView | null {
  let raw: string;
  let mtime: string;
  try {
    const abs = join(root, rel);
    raw = readFileSync(abs, "utf8");
    mtime = statSync(abs).mtime.toISOString();
  } catch {
    return null;
  }
  return { rel, mtime, ...noteText(rel, raw) };
}

/** Shared interpretation for file reads and projected Markdown snapshots. */
export function noteText(rel: string, raw: string): Pick<NoteView, "envelope" | "body" | "title"> {
  const { envelope, body } = parseEnvelope(raw);
  const title =
    (envelope.title ?? "").trim() ||
    (body.match(/^#\s+(.+)$/m)?.[1] ?? "").trim() ||
    (rel.split("/").at(-1) ?? rel).replace(/\.md$/, "");
  return { envelope, body, title };
}

/** Prose head of a note body: headings/images dropped, link syntax unwrapped
 * to its label (or its target#sub, via the same parseWikilinks lib/links.ts
 * exports), whitespace collapsed, ellipsized at `max`. */
export function excerpt(body: string, max = 280): string {
  const filtered = body
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) && !/^\s*!\[/.test(l))
    .join(" ");
  let unlinked = "";
  let last = 0;
  for (const link of parseWikilinks(filtered)) {
    unlinked += filtered.slice(last, link.index) + wikilinkText(link);
    last = link.index + link.raw.length;
  }
  unlinked += filtered.slice(last);
  const text = unlinked
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
