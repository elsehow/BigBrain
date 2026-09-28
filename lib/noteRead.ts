/**
 * noteRead.ts — the read jail and the note payload, extracted from
 * lib/api.ts so every reader door serves ONE implementation (#264's
 * one-table discipline, applied to reads). `/v1/note` and the MCP server's
 * `read_note` (#87) both call `notePayload`; they cannot drift because
 * there is nothing to drift between.
 *
 * The jail is design-principles §5: a reader may fetch the committed
 * canonical record and the raw sources it cites — nothing else. `.state`,
 * `.env`, `.git`, `.blobs`, `prompts/`, and any traversal are denied by
 * not being under an allowed tree. `memory/` stays out of READ_TREES —
 * widening it would hand the tree to `/v1/ls` and `/v1/file` too — and is
 * served here through its OWN one-tree jail instead, because the contract
 * this door owes its callers is: **any path the system itself prints must
 * be fetchable here.** The memory index prints `[[memory/slug]]` into every
 * session, and `/v1/note` used to answer that path with "forbidden".
 */

import type { NoteWindow } from "./noteWindow";
export type { NoteWindow } from "./noteWindow";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  assertionEntityExists,
  filterEntityView,
  isAssertionEntityPath,
  projectedEntityMarkdown,
  projectedEntityToc,
  sourceThreadView,
  sourceThreadMarkdown,
} from "./assertionEntityView";
import { isSourceThreadPath } from "./sourceThreads";
import { sourceMoment } from "./insertionLog";
import { parseWikilinks } from "./linkSyntax";
import { DEFAULT_SLACK, matchBody } from "./noteMatch";
import { withinRoot } from "./browsePaths";
import { resolveNote, readNoteFile } from "./noteResolution";
import { sessionMarkdown } from "./workSessionView";
import {
  isSourceInsertionPath,
  sourceInsertionMarkdown,
} from "./sourceFeed";
import { walkMarkdown } from "./vaultRead";

/** The ONLY vault trees a reader may list or fetch: the committed
 * canonical record and the raw sources it cites (§5 read jail). */
export const READ_TREES = ["references", "entities", "journal", "inbox/unsorted"] as const;

/** Wikilinks resolve against the curated trees, entities first (the
 * first basename match wins). */
const RESOLVE_TREES = ["entities", "references"] as const;

/** Served by this door alone (see the module header), never by /v1/ls or
 * /v1/file. */
const MEMORY_TREE = "memory";

/** Defensive ceiling on tree walks — an alpha vault is far smaller. */
const WALK_CAP = 5_000;

/** The shared walk (lib/vaultRead.ts) under the shared ceiling. */
export function walkTrees(root: string, trees: readonly string[]): string[] {
  return walkMarkdown(root, trees, { cap: WALK_CAP });
}

/** The lexical half of both jails: lib/browsePaths.ts's withinRoot over the
 * given allowlist, after this door's own hygiene checks (absolute inputs and
 * NUL bytes never reach the resolver); then, if the target exists, the same
 * containment over realpaths, so a symlink under an allowed tree cannot
 * point outside it. Existence is the caller's concern — a jailed-but-absent
 * path returns the abs path and the route answers 404, keeping 403 and 404
 * distinct. */
function jailUnder(root: string, rel: string, trees: readonly string[]): string | null {
  if (!rel || rel.startsWith("/") || rel.includes("\0")) return null;
  const abs = withinRoot(root, rel, trees);
  if (!abs) return null;
  try {
    const realRoot = realpathSync(root);
    const realRel = relative(realRoot, realpathSync(abs)).split(sep).join("/");
    if (!withinRoot(realRoot, realRel, trees)) return null;
  } catch {
    /* ENOENT: a path that does not exist cannot symlink out — the lexical
     * jail already holds, and the route will 404. */
  }
  return abs;
}

/** Resolve a vault-relative request path inside the read jail, or null (→403). */
export function jailPath(root: string, rel: string): string | null {
  return jailUnder(root, rel, READ_TREES);
}

/** Resolve one file inside `memory/`, or null (→403). A jail of its own,
 * one tree wide — see the module header. */
export function jailMemoryPath(root: string, rel: string): string | null {
  if (rel.startsWith("/")) return null; // join() would keep an absolute rel inside the tree
  return jailUnder(root, join("memory", rel), ["memory"]);
}

/** The same jail, addressed the way the memory index writes it: the full
 * vault-relative `memory/<slug>.md` rather than `/v1/memory`'s bare slug.
 * Null for anything that is not under the tree — traversal included, since
 * the slice below only strips the prefix and `jailMemoryPath` still walks
 * what is left through `withinRoot`. */
export function jailMemoryNotePath(root: string, rel: string): string | null {
  return rel.startsWith(`${MEMORY_TREE}/`)
    ? jailMemoryPath(root, rel.slice(MEMORY_TREE.length + 1))
    : null;
}

/** `[[target]]` / `[[target#sub|label]]` targets in order of appearance,
 * unique, capped — a note's link chips, not an exhaustive graph. An anchor
 * resolves like a bare target (chip resolution only needs the note it
 * names), so it's dropped from the name — parseWikilinks (lib/links.ts) is
 * what tells target and #sub apart; #257 was this function keeping them
 * fused and never resolving an anchored link. */
export function wikilinks(body: string, cap = 12): string[] {
  const names: string[] = [];
  for (const { target } of parseWikilinks(body)) {
    if (target && !names.includes(target)) names.push(target);
    if (names.length >= cap) break;
  }
  return names;
}

/** lowercased link target → vault-relative path. TWO keys per note:
 *
 * - its **root-relative path sans `.md`** — `entities/ada-lovelace` — which is
 *   the form the vault mandates and the only unambiguous one, since a target
 *   that names its tree lets two notes share a basename;
 * - its **bare basename**, first (most-curated tree) wins — still resolvable
 *   because writers used it for years.
 *
 * The two key spaces cannot collide: every qualified key contains a `/` and no
 * basename does. Alias resolution stays out — it would read every note body. */
export function linkIndex(root: string): Map<string, string> {
  const idx = new Map<string, string>();
  for (const rel of walkTrees(root, RESOLVE_TREES)) {
    idx.set(rel.replace(/\.md$/, "").toLowerCase(), rel);
    const base = (rel.split("/").at(-1) ?? "").replace(/\.md$/, "").toLowerCase();
    if (base && !idx.has(base)) idx.set(base, rel);
  }
  return idx;
}

/**
 * One wikilink target → the path a reader can fetch it at, or null.
 *
 * `linkIndex` answers for the two CURATED trees it walks, and it is blind to
 * every other note this door serves: a projected dossier's citations are
 * `[[log/insertions/…|title]]`, its cross-references are
 * `[[projection/entities/ent_…|label]]`, and the memory index writes
 * `[[memory/slug|title]]` — none of which are files under entities/ or
 * references/, so all three resolved to null and a body dense with links
 * reported `links: []`. A target that already NAMES a servable path resolves
 * to itself; the index still answers first for everything it knows, so bare
 * basenames and `entities/ada-lovelace` keep the meaning they have always had.
 */
export function resolveLink(root: string, target: string, idx: Map<string, string>): string | null {
  if (isSourceThreadPath(target)) return sourceThreadView(root, target) ? target : null;
  if (isSourceInsertionPath(target)) return existsSync(join(root, target)) ? target : null;
  if (isAssertionEntityPath(target)) return assertionEntityExists(root, target) ? target : null;
  const known = idx.get(target.toLowerCase());
  if (known) return known;
  // Only a qualified target may name a file: a bare basename belongs to the
  // index above, whose tree order decides which of two same-named notes wins.
  if (!target.includes("/")) return null;
  const md = target.endsWith(".md") ? target : `${target}.md`;
  const abs = md.startsWith(`${MEMORY_TREE}/`) ? jailMemoryNotePath(root, md) : jailPath(root, md);
  return abs && existsSync(abs) ? md : null;
}

/** Every link in a body, resolved — the `links` array of every note this
 * door serves, projected ones included. The index is built only when there
 * is a link to resolve, so a note without any costs no tree walk. */
function resolvedLinks(root: string, markdown: string): { name: string; path: string | null }[] {
  const names = wikilinks(markdown);
  if (!names.length) return [];
  const idx = linkIndex(root);
  return names.map((name) => ({ name, path: resolveLink(root, name, idx) }));
}

/** One note, every door's shape: `/v1/note`'s JSON body, verbatim. */
export interface NoteJson {
  path: string;
  title: string;
  mtime: string | null;
  category: unknown;
  date: unknown;
  source: unknown;
  tags: unknown[];
  sources: unknown[];
  markdown: string;
  links: { name: string; path: string | null }[];
  /** Projected entities only: how many assertions the record holds for it,
   * and how many `markdown` carries after the reader's window
   * (EntityViewFilter) was applied. Equal on an unfiltered read; on a
   * `toc` read, how many the table of contents accounts for. */
  assertions_total?: number;
  assertions_shown?: number;
  /** Sources and markdown notes windowed by `q`: how many blocks (blank-line
   * separated runs — a paragraph, or one transcript turn) the body holds,
   * how many matched, how many `markdown` carries with their context, and how
   * many matches the budget could not fit. Absent on an unwindowed read. */
  blocks_total?: number;
  blocks_matched?: number;
  blocks_shown?: number;
  blocks_dropped?: number;
}

export type NotePayload =
  | { status: 200; rel: string; note: NoteJson }
  | { status: 403 | 404; error: string };

/** The caption a windowed body wears — first line of the served markdown, so
 * a reader that only sees the head still learns the note was cut and how. */
function bodyCaption(w: ReturnType<typeof matchBody>, q: string, slack: number): string {
  const dropped = w.blocks_dropped
    ? ` ${w.blocks_dropped} more matched but did not fit — narrow q= or read the saved markdown.`
    : "";
  return (
    `_Windowed: ${w.blocks_matched} of ${w.blocks_total} blocks match ${JSON.stringify(q)}; ` +
    `showing ${w.blocks_shown} with ±${slack} blocks of context.` +
    ` Line numbers are the whole note's.${dropped}_`
  );
}

/** Apply a `q=` window to a body, or hand it back untouched. The two
 * non-entity branches of notePayload share this so a source and a markdown
 * note cannot answer the same query differently. */
function windowedBody(markdown: string, window: NoteWindow): Pick<NoteJson, "markdown" | "blocks_total" | "blocks_matched" | "blocks_shown" | "blocks_dropped"> {
  if (!window.q) return { markdown };
  const slack = window.slack ?? DEFAULT_SLACK;
  const w = matchBody(markdown, window.q, { slack });
  return {
    markdown: [bodyCaption(w, window.q, slack), "", w.text].join("\n"),
    blocks_total: w.blocks_total,
    blocks_matched: w.blocks_matched,
    blocks_shown: w.blocks_shown,
    blocks_dropped: w.blocks_dropped,
  };
}

/**
 * The note a reader should see, by vault-relative path — a projected source
 * insertion, a projected entity, or a jailed markdown file, in that order
 * (the same precedence `/v1/note` has always had). The caller records the
 * use (each door owns its `via`) and serializes.
 */
export function notePayload(root: string, relRaw: string, window: NoteWindow = {}): NotePayload {
  const resolved = resolveNote(root, relRaw, { sessions: true, markdown: path => {
    const abs = path.endsWith(".md") && (jailMemoryNotePath(root, path) ?? jailPath(root, path));
    return abs ? readNoteFile(root, abs) : undefined;
  } });
  if (resolved?.kind === "session") {
    const { session } = resolved;
    const markdown = sessionMarkdown(session);
    return { status: 200, rel: relRaw, note: { path: relRaw, title: session.title, mtime: session.updated, category: "session", date: session.updated, source: session.provider, tags: [session.provider], sources: [], links: parseWikilinks(markdown).map(link => ({ name: link.target, path: link.target })), markdown } };
  }
  if (resolved?.kind === "thread") {
    const { thread } = resolved;
    const markdown = sourceThreadMarkdown(thread), latest = thread.members[0]!;
    return { status: 200, rel: relRaw, note: {
      path: relRaw, title: thread.title, mtime: sourceMoment(latest) || null,
      category: "thread", date: sourceMoment(latest) || null, source: "email", tags: ["thread"], sources: [],
      links: resolvedLinks(root, markdown), ...windowedBody(markdown, window),
    } };
  }
  if (isSourceThreadPath(relRaw)) return { status: 404, error: `no thread at ${relRaw}` };
  if (resolved?.kind === "source") {
    const { source } = resolved;
    const markdown = sourceInsertionMarkdown(source);
    return {
      status: 200,
      rel: relRaw,
      note: {
        path: relRaw,
        title: source.title,
        mtime: sourceMoment(source) || null,
        category: source.envelope["category"] ?? null,
        date: sourceMoment(source) || null,
        source: source.envelope["source"] ?? null,
        tags: Array.isArray(source.envelope["tags"]) ? source.envelope["tags"] : [],
        sources: [],
        // Links resolve from the WHOLE body, never the window: a reader
        // that asked for one region still gets the note's trail out.
        links: resolvedLinks(root, markdown),
        ...windowedBody(markdown, window),
      },
    };
  }
  // Projected entities are virtual notes, same as source insertions above:
  // the web door has served them since the entity view landed, and search
  // returns their paths — an agent must be able to follow its own hit.
  if (resolved?.kind === "entity") {
    const { entity } = resolved;
    const view = filterEntityView(entity, window);
    const total = entity.assertions.length;
    const windowed = view.assertions.length < total || window.order === "desc";
    const caption = windowed
      ? [
          `${view.assertions.length} of ${total} assertions`,
          ...(window.q ? [`matching ${JSON.stringify(window.q)}`] : []),
          ...(window.after ? [`from ${window.after}`] : []),
          ...(window.before ? [`to ${window.before}`] : []),
          ...(window.order === "desc" ? ["newest first"] : []),
        ].join(", ")
      : undefined;
    // `toc` elides a big dossier to its table of contents (#620); either
    // way this ONE value is both what the reader is shown and what the
    // links below are resolved from.
    const dossier = window.toc ? projectedEntityToc(view) : projectedEntityMarkdown(view, caption);
    return {
      status: 200,
      rel: relRaw,
      note: {
        path: relRaw,
        title: entity.label,
        mtime: null,
        category: null,
        date: null,
        source: null,
        tags: [],
        sources: [],
        markdown: dossier,
        // The dossier IS a navigation surface — every bullet cites its
        // sources and names other entities — so its links are the reader's
        // way out of it. Unlike a source (above), these resolve over the
        // WINDOWED markdown: each assertion is self-contained, so links to
        // assertions the reader was not shown are noise, not a trail.
        links: resolvedLinks(root, dossier),
        assertions_total: total,
        assertions_shown: view.assertions.length,
      },
    };
  }
  // A path SHAPED like a projected note that the record does not hold is a
  // 404 that says why, never the jail's 403. The projection search reads is
  // append-only sync: a retraction commit removes the event file and the row
  // survives it, so search can still name a source the log no longer has
  // (searchCore drops those now, but a stale bookmark or a pasted path can
  // still arrive here). "forbidden path" sent that reader hunting for a
  // permission problem that was never there.
  if (isSourceInsertionPath(relRaw))
    return {
      status: 404,
      error: `no source event at ${relRaw} — it is not in the log (retracted, moved, or unreadable)`,
    };
  if (isAssertionEntityPath(relRaw))
    return { status: 404, error: `no entity at ${relRaw} — the record holds no assertions about it` };
  // `forbidden path` leads, because the plugin's bb.sh greps for exactly that
  // to tell a path refusal from a missing scope; the reason follows it.
  const memoryAbs = jailMemoryNotePath(root, relRaw);
  const abs = memoryAbs ?? jailPath(root, relRaw);
  if (!abs || !relRaw.endsWith(".md"))
    return {
      status: 403,
      error: `forbidden path: ${relRaw || "(empty)"} is not in the served set (${[
        ...READ_TREES,
        MEMORY_TREE,
        "projection/entities",
        "log/insertions",
      ].join(", ")})`,
    };
  if (resolved?.kind !== "markdown") return { status: 404, error: "not found" };
  const { path: rel, markdown: v } = resolved;
  return {
    status: 200,
    rel,
    note: {
      path: rel,
      title: v.title,
      mtime: v.mtime ?? null,
      category: v.envelope.category ?? null,
      date: v.envelope.date ?? null,
      source: v.envelope.source ?? null,
      tags: v.envelope.tags ?? [],
      sources: v.envelope.sources ?? [],
      // Links resolve from the WHOLE body, never the window: a reader that
      // asked for one region still gets the note's trail out.
      links: resolvedLinks(root, v.body),
      ...windowedBody(v.body, window),
    },
  };
}

/** The same note as text/markdown — what `/v1/note?format=markdown` serves
 * and the plugin saves beside a big note's JSON: the body with its
 * newlines intact (a JSON string is one line, and a line-addressed reader
 * cannot slice it), a short header naming the note, and the resolved links
 * at the end so the trail survives the format. */
export function noteMarkdownText(note: NoteJson): string {
  const header = [
    `<!-- ${note.path} -->`,
    `# ${note.title}`,
    ...(note.date ? [`date: ${String(note.date)}`] : []),
    ...(note.assertions_total !== undefined
      ? [`assertions: ${note.assertions_shown} of ${note.assertions_total}`]
      : []),
    ...(note.blocks_total !== undefined
      ? [`blocks: ${note.blocks_shown} shown, ${note.blocks_matched} of ${note.blocks_total} matched`]
      : []),
  ];
  const links = note.links.length
    ? ["", "## Links", ...note.links.map((l) => `- ${l.name} → ${l.path ?? "(unresolved)"}`)]
    : [];
  return [...header, "", note.markdown.replace(/\s+$/u, ""), ...links, ""].join("\n");
}

/** `memory/MEMORY.md`, or one topic file, raw — the same contract as
 * `/v1/memory`: links are NOT resolved the way notes resolve them, because
 * the consumer is an agent that follows each `[[memory/slug]]` back through
 * this door and each record link through `notePayload`. */
export function memoryRead(root: string, slug = ""): { status: 200; text: string } | { status: 403 | 404; error: string } {
  const abs = jailMemoryPath(root, slug ? `${slug}.md` : "MEMORY.md");
  if (!abs) return { status: 403, error: "forbidden path" };
  try {
    return { status: 200, text: readFileSync(abs, "utf8") };
  } catch {
    return { status: 404, error: "not found" };
  }
}
