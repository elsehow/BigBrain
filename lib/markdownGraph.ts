/** Explicit note links shared by the graph and its Quick-model reading aid. */
import { AST_CITE } from "./ids";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withinRoot, BROWSE_ROOTS } from "./browsePaths";
import type { GraphNode } from "./graph";
import { maskFences, parseWikilinks } from "./linkSyntax";
import { walkMarkdown, noteText } from "./vaultRead";

export interface ConnectionEvidence { text: string; path?: string; assertion?: string }
export type ObserveConnection = (from: string, to: string, evidence: ConnectionEvidence) => void;
export interface MarkdownIdentity { id: string; path: string; title: string }
export interface MarkdownDocument extends MarkdownIdentity { body: string }

export function readMarkdownNote(root: string, path: string): string | undefined {
  const abs = withinRoot(root, path);
  if (!abs || !path.endsWith(".md")) return;
  try {
    const real = realpathSync(abs), realRoot = realpathSync(root);
    if (!withinRoot(realRoot, relative(realRoot, real))) return;
    return readFileSync(real, "utf8");
  } catch { return; }
}

/** Exact paths/ids first; bare titles resolve only when unambiguous. */
export function noteLinkResolver(nodes: Iterable<GraphNode>, aliases: Iterable<[string, string]> = []) {
  const paths = new Map<string, Set<string>>(), names = new Map<string, Set<string>>();
  const norm = (s: string) => s.toLowerCase().replace(/\.md$/, "");
  const put = (map: Map<string, Set<string>>, key: string, id: string) => {
    const k = norm(key); const set = map.get(k) ?? new Set<string>(); set.add(id); map.set(k, set);
  };
  for (const n of nodes) {
    for (const key of [n.id, n.path, ...(n.memberPaths ?? [])]) if (key) put(paths, key, n.id);
    put(names, n.title, n.id);
    if (n.path) put(names, n.path.split("/").at(-1)!, n.id);
  }
  for (const [key, id] of aliases) put(paths, key, id);
  const one = (set?: Set<string>) => set?.size === 1 ? [...set][0] : undefined;
  return (target: string, from: string, markdown = false): string | undefined => {
    let t: string;
    try { t = decodeURIComponent(target).split(/[?#]/)[0]!.replace(/^<|>$/g, ""); } catch { return; }
    if (!t || t.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(t)) return;
    const collapse = (s: string) => { const out: string[] = []; for (const bit of s.split("/")) {
      if (bit === "..") { if (!out.length) return ""; out.pop(); } else if (bit && bit !== ".") out.push(bit);
    } return out.join("/"); };
    if (markdown) {
      const local = one(paths.get(norm(collapse(`${from.split("/").slice(0, -1).join("/")}/${t}`))));
      if (local) return local;
    }
    return one(paths.get(norm(collapse(t)))) ?? (!t.includes("/") ? one(names.get(norm(t))) : undefined);
  };
}

export interface ParsedDocumentLinks {
  links: Array<{ target: string; markdown: boolean; text: string }>;
  citations: string[];
}

/** Extract once on content changes; resolution against identities happens
 * separately, so an alias/rename can resolve an old link without reparsing. */
export function parseDocumentLinks(document: MarkdownDocument, fencedText = maskFences(document.body)): ParsedDocumentLinks {
  // Keep offsets stable; examples in code are not actual links.
  const text = fencedText.replace(/(`+)([^`]*?)\1/g, m => " ".repeat(m.length));
  const hits = parseWikilinks(text).map(m => ({ target: m.target, index: m.index, length: m.raw.length, markdown: false }));
  // Most large source transcripts contain no Markdown links. Avoid expensive
  // bracket scans when the required inline/reference delimiters are absent.
  if (text.includes("](")) {
    // Walk brackets once. Asking an unanchored label regex to reject every
    // bracket across a large transcript can dominate graph reconstruction.
    const brackets = /[[\]]/g;
    const destination = /\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/y;
    let open = -1, bracket: RegExpExecArray | null;
    while ((bracket = brackets.exec(text))) {
      const at = bracket.index;
      if (bracket[0] === "[") { open = text[at - 1] === "!" ? -1 : at; continue; }
      const start = open; open = -1;
      if (start < 0 || text[at + 1] !== "(") continue;
      destination.lastIndex = at + 2;
      const target = destination.exec(text);
      if (!target) continue;
      hits.push({ target: target[1]!, index: start, length: destination.lastIndex - start, markdown: true });
      brackets.lastIndex = destination.lastIndex;
    }
  }
  const definitions = new Map(text.includes("]:") ? [...text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gm)].map(m => [m[1]!.trim().toLowerCase(), m[2]!] as const) : []);
  if (definitions.size) for (const m of text.matchAll(/(?<!!)\[([^\][]+)\](?:\[([^\][]*)\])?/g)) {
    if (text[m.index! - 1] === "[" || ["[", "]", "(", ":"].includes(text[m.index! + m[0].length] ?? "")) continue;
    const target = definitions.get((m[2] || m[1]!).trim().toLowerCase());
    if (target) hits.push({ target, index: m.index!, length: m[0].length, markdown: true });
  }
  const links = hits.sort((a, b) => a.index - b.index).map(hit => {
    // Only inspect the snippet window, rather than rescanning a whole long
    // transcript backward and forward for every resolved mention.
    const lower = Math.max(0, hit.index - 350), upper = Math.min(text.length, hit.index + hit.length + 350);
    const before = text.slice(Math.max(0, lower - 1), hit.index).lastIndexOf("\n\n");
    const start = Math.max(lower, before < 0 ? 1 : Math.max(0, lower - 1) + before + 2);
    const after = text.slice(hit.index + hit.length, upper).indexOf("\n\n");
    const end = after < 0 ? upper : hit.index + hit.length + after;
    return { target: hit.target, markdown: hit.markdown, text: document.body.slice(start, end).trim() };
  });
  return { links, citations: [...new Set([...fencedText.matchAll(AST_CITE)].map(m => m[1]!))] };
}

export function resolveDocumentLinks(document: Pick<MarkdownIdentity, "id" | "path">, parsed: ParsedDocumentLinks, resolve: ReturnType<typeof noteLinkResolver>): Array<{ target: string; evidence: ConnectionEvidence }> {
  return parsed.links.flatMap(hit => {
    const target = resolve(hit.target, document.path, hit.markdown);
    return !target || target === document.id ? [] : [{ target, evidence: { path: document.path, text: hit.text } }];
  });
}

export function explicitNoteLinks(document: MarkdownDocument, resolve: ReturnType<typeof noteLinkResolver>, fencedText = maskFences(document.body)): Array<{ target: string; evidence: ConnectionEvidence }> {
  return resolveDocumentLinks(document, parseDocumentLinks(document, fencedText), resolve);
}

/** Metadata census, including realpath in the stamp so retargeted symlinks
 * cannot reuse content outside the allowed trees. No body reads on a hit. */
export function markdownInventory(root: string): Map<string, string> {
  const files = new Map<string, string>();
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return files; }
  for (const path of walkMarkdown(root, [...BROWSE_ROOTS], { skipDotted: true }).sort()) {
    try {
      const real = realpathSync(join(root, path));
      if (!withinRoot(realRoot, relative(realRoot, real))) continue;
      const st = statSync(real, { bigint: true });
      files.set(path, `${real}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`);
    } catch { /* A concurrently removed or inaccessible note is absent. */ }
  }
  return files;
}

export function markdownDocument(path: string, body: string): MarkdownDocument {
  return { id: path, path, title: noteText(path, body).title, body };
}
