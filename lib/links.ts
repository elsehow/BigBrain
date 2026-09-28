/**
 * links.ts — wikilink parsing, Obsidian-rule resolution, and the one-time
 * dialect migration.
 *
 * The vault's links are Obsidian-legal, and as of 2026-08-06 they are
 * Obsidian's STRICTEST legal form: [[entities/big-brain]], a path from the
 * vault root, which is exactly what the app writes under New link format =
 * "Absolute path in vault". Still no house dialect — any checkout is a real
 * Obsidian vault and off-the-shelf tooling agrees about what's broken — but
 * a target now says which tree it means, so two notes may share a basename
 * without either link becoming a guess. Bare targets still RESOLVE (a
 * vault mid-migration must not go dark) and are reported as `unqualified`
 * until `migrate` qualifies them.
 *
 * `check` is the enforcement half: it is a dumb validator of that public
 * rule, run by the editor mid-pass (bin/links.ts) and by the runner after
 * every pass (the journal's brokenLinks is a computed fact, not a model
 * claim). `migrate` is the one-time cleanup from the old dialect, which
 * had two habits: prose targets for entities ([[Ada Lovelace]] meaning
 * ada-lovelace.md) and date-stripped kebab targets for dated notes. Both
 * reduce to one rule — slugify the target, slugify each basename with its
 * date prefix stripped, and rewrite every unresolved link with exactly
 * one match to the full filename, keeping the prose via |alias.
 * Everything else lands in the report for the deep pass to adjudicate.
 *
 * Notes live under the view tree — inbox/ arrivals are transient and
 * would make the count flap.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITY_TYPES, parseEnvelope } from "./envelope";
import { referenceIdMap, listReferencePaths } from "./references";
import { slug } from "./slug";
import { LINK_RE, MD_LINK_RE, pathIndex, mdTarget, maskFences, rewriteLinks, type MdLink } from "./linkSyntax";
// Keep established maintenance entry points; readers import the syntax layer.
export { maskFences, parseWikilinks, wikilinkText, type WikilinkMatch, type MdLink } from "./linkSyntax";

// entities/ is the one maintained view tree; memory/ is the derived
// working set, walked here so its own links resolve.
const NOTE_ROOTS = ["entities", "memory"];

export type Link = {
  file: string; // vault-relative path of the note containing the link
  line: number; // 1-indexed
  target: string; // link target as written (no #sub, no |label)
  sub: string; // "#heading" / "^block" suffix, if any
  label: string | null; // |label, if any
};

/** Every note under the view tree (entities/) plus memory/, as
 * vault-relative paths. */
export function listNotes(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(rel, e.name));
      else if (e.name.endsWith(".md")) out.push(join(rel, e.name));
    }
  };
  for (const r of NOTE_ROOTS) if (existsSync(join(root, r))) walk(r);
  return out.sort();
}

const base = (path: string): string => (path.split("/").at(-1) ?? path).replace(/\.md$/, "");
const stripDate = (b: string): string => b.replace(/^\d{4}-\d{2}-\d{2}-/, "");

/** lowercased basename → vault-relative paths bearing it. */
export function noteIndex(paths: string[]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const p of paths) {
    const k = base(p).toLowerCase();
    idx.set(k, [...(idx.get(k) ?? []), p]);
  }
  return idx;
}

/** All wikilinks in a note, skipping fenced code blocks. */
export function parseLinks(root: string, file: string): Link[] {
  const text = maskFences(readFileSync(join(root, file), "utf8"));
  const out: Link[] = [];
  for (const m of text.matchAll(LINK_RE))
    out.push({
      file,
      line: text.slice(0, m.index).split("\n").length,
      target: m[1]!.trim(),
      sub: m[2] ?? "",
      label: m[3]?.replace(/\s+/g, " ").trim() ?? null,
    });
  return out;
}

/** Paths a target resolves to. Two shapes, and the difference is the whole
 * rule:
 *
 * A PATH-SHAPED target names its own tree, so it may reach anywhere the
 * vault goes — memory/ included. It matches EXACTLY from the vault root:
 * Obsidian's "Absolute path in vault" link format, the strictest of its
 * three. (Suffix matching, which this used to do, would let
 * [[people/foo]] silently mean entities/people/foo.md — the ambiguity the
 * root-relative rule exists to kill.)
 *
 * A BARE target never means a memory file, for anyone — memory notes
 * included. [[big-brain]] is the entity even where a memory topic shares
 * the basename; that topic is reachable only as [[memory/big-brain]]. One
 * filter, one place: this is the whole of "bare names live in the record."
 */
export function resolve(target: string, idx: Map<string, string[]>): string[] {
  const t = target.toLowerCase().replace(/\.md$/, "");
  if (t.includes("/")) {
    // a path can be indexed under several keys (basename, origin, title,
    // aliases — see noteIndex), so dedupe: one path is one hit
    const hits = new Set<string>();
    for (const paths of idx.values())
      for (const p of paths) if (p.replace(/\.md$/, "").toLowerCase() === t) hits.add(p);
    return [...hits];
  }
  return (idx.get(t) ?? []).filter((p) => !p.startsWith(MEMORY_PREFIX));
}

export type CheckResult = {
  total: number;
  broken: Link[];
  ambiguous: Link[];
  boundary: Link[];
  /** links written as a bare basename rather than a vault-root path */
  unqualified: Link[];
  /** markdown links pointing at notes — invisible to the link graph */
  markdown: MdLink[];
};

// ── the memory boundary (Nick's rule, 2026-08-05; corrected 2026-08-06) ───
// "Ingest NEVER links to memory notes. Should not even see them. ONLY
// links to references. (Memory notes can link to anything.)" The record —
// entities, references, everything upstream — must never depend on the
// working set derived from it.
//
// The first implementation enforced that by amputating the namespace:
// memory/ paths joined no index, for anyone. That overshot the rule's own
// parenthetical — it also severed memory→memory, so MEMORY.md could not
// wikilink its own topic files and addressed them by markdown path
// instead, invisible to every link tool here. The boundary is a DIRECTION,
// not a namespace:
//
//   record → memory   forbidden  (cache is not evidence)  → `boundary`
//   memory → record   free
//   memory → memory   free       (the parenthetical, honoured)
//
// The basename half survives intact and now lives in resolve(): a bare
// name never means a memory file, so [[big-brain]] is the entity
// everywhere. Reaching a memory topic takes saying so — [[memory/big-brain]].

const MEMORY_PREFIX = "memory/";
const inMemory = (path: string): boolean => path.startsWith(MEMORY_PREFIX);

/** Validate every link in the vault. Only the maintained trees are CHECKED
 * — references are immutable record, never repaired — but reference paths
 * join the RESOLUTION index, so a dossier's [[references/x]] citation
 * counts as resolved.
 *
 * Four verdicts, and a link can earn `unqualified` alongside any other:
 *   broken       resolves to nothing
 *   ambiguous    resolves to several notes
 *   boundary     a record note reaching into memory/, either by naming the
 *                path outright or by a bare name only memory answers to
 *   unqualified  written as a bare basename, not a vault-root path
 *
 * And one verdict on links that are not wikilinks at all:
 *   markdown     a [label](note.md) link — it points at a real note, but
 *                NOTHING here can see it. parseLinks reads [[...]] only,
 *                so a markdown link is a note quietly leaving the record's
 *                link structure. This class exists because
 *                that is precisely how memory/MEMORY.md sat outside its
 *                own vault's link graph until 2026-08-06: the amputated
 *                namespace made wikilinks impossible, the prompt taught
 *                the workaround, and no check could see the result.
 */
export function checkLinks(root: string): CheckResult {
  const notes = listNotes(root);
  const refs = listReferencePaths(root);
  const idx = noteIndex([...notes, ...refs]);
  const known = pathIndex([...notes, ...refs]);
  // bare-name lookup over memory alone — resolve() deliberately cannot do
  // this (it filters memory out of every bare answer), and the diagnosis
  // is worth the extra map: "you meant the memory topic" beats "typo".
  const memBare = noteIndex(notes.filter(inMemory));
  const broken: Link[] = [];
  const ambiguous: Link[] = [];
  const boundary: Link[] = [];
  const unqualified: Link[] = [];
  const markdown: MdLink[] = [];
  let total = 0;
  for (const f of notes) {
    let raw: string;
    try {
      raw = readFileSync(join(root, f), "utf8");
    } catch {
      continue; // deleted between listNotes and here (a live editor pass), or a dangling symlink — a note that can't be read has no links to check
    }
    const text = maskFences(raw);
    for (const m of text.matchAll(MD_LINK_RE)) {
      if (m[1]) continue; // an image points at an asset, not a note
      const resolved = mdTarget(f, m[3]!, known);
      if (!resolved || resolved === f) continue;
      markdown.push({
        file: f,
        line: text.slice(0, m.index).split("\n").length,
        href: m[3]!,
        label: m[2]!.replace(/\s+/g, " ").trim(),
        resolved,
      });
    }
  }
  for (const f of notes) {
    let links: Link[];
    try {
      links = parseLinks(root, f);
    } catch {
      continue; // same tolerance as the markdown loop above: unreadable ⇒ no links to check
    }
    for (const l of links) {
      total++;
      const fromRecord = !inMemory(f);
      const t = l.target.toLowerCase().replace(/\.md$/, "");
      if (!t.includes("/")) unqualified.push(l);
      const hits = resolve(l.target, idx);
      if (hits.length === 0) {
        if (fromRecord && (memBare.get(t)?.length ?? 0) > 0) boundary.push(l);
        else broken.push(l);
      } else if (hits.length > 1) ambiguous.push(l);
      else if (fromRecord && inMemory(hits[0]!)) boundary.push(l);
    }
  }
  return { total, broken, ambiguous, boundary, unqualified, markdown };
}

// ── the citation contract (phase 3 of the lake/vault/queue plan) ──────────
// Vault notes cite the references they draw on via `sources:` frontmatter.
// checkSources is the enforcement half, symmetrical with checkLinks: a dumb
// validator run by `bigbrain links check` and the runner. GRANDFATHERING IS
// THE CONTRACT — a note with no `sources:` at all is silently fine (the
// pre-phase-3 vault must never start failing checks it passed yesterday);
// only refs that are PRESENT and resolve to nothing are reported.

/** One unresolvable `sources:` entry — reported like a broken wikilink. */
export type SourceRef = {
  file: string; // vault-relative path of the citing note
  ref: string; // the sources entry as written
};

export type SourcesResult = {
  /** Notes carrying a `sources:` list at all. */
  citing: number;
  /** `sources:` entries seen across the vault. */
  total: number;
  unresolved: SourceRef[];
};

/** A note's `sources:` list, tolerantly: absent, malformed frontmatter, or
 * a non-list value all read as "no sources" (grandfathered — the check can
 * only hold notes to refs they actually declare). A bare string is accepted
 * as a one-entry list. */
export function noteSources(root: string, file: string): string[] | null {
  let src: unknown;
  try {
    src = parseEnvelope(readFileSync(join(root, file), "utf8")).envelope.sources;
  } catch {
    return null;
  }
  if (typeof src === "string") return src.trim() ? [src.trim()] : null;
  if (!Array.isArray(src)) return null;
  const refs = src
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .map((s) => s.trim());
  return refs.length ? refs : null;
}

/** Does one `sources:` ref resolve? Same semantics as the editor era's
 * resolveRefs: a ref with a slash is a
 * vault-relative path (a reference), anything
 * else is a reference id. */
function sourceResolves(root: string, ref: string, refIds: Map<string, string>): boolean {
  if (ref.includes("/")) return existsSync(join(root, ref));
  return refIds.has(ref);
}

/** Validate every `sources:` ref in the vault's curated notes against the
 * record — notes without `sources:` are silently fine. */
export function checkSources(root: string): SourcesResult {
  const refIds = referenceIdMap(root);
  const res: SourcesResult = { citing: 0, total: 0, unresolved: [] };
  for (const f of listNotes(root)) {
    const refs = noteSources(root, f);
    if (!refs) continue;
    res.citing++;
    for (const ref of refs) {
      res.total++;
      // The memory boundary applies to citations too: memory/ is cache,
      // not evidence — a record note's sources: may never point into it,
      // even though the file exists.
      if (!f.startsWith("memory/") && ref.startsWith("memory/"))
        res.unresolved.push({ file: f, ref });
      else if (!sourceResolves(root, ref, refIds)) res.unresolved.push({ file: f, ref });
    }
  }
  return res;
}

// ── the type vocabulary (Nick's rule, 2026-08-05) ─────────────────────────
// The vault has exactly three types, and each is a TREE: references/ holds
// `type: reference`, entities/ holds `type: entity`, memory/ is derived and
// carries no envelope typing at all (the memory boundary above is its
// rule). `note` is retired; `request` is a routing kind (intake diverts it
// to the editor's work queue), never a type in the record. checkTypes is
// the enforcement half: a dumb sweep of the two frontmatter-typed trees,
// run by `bigbrain links check` — informational like every check here, so
// the editor adjudicates what a violation MEANS.

/** One frontmatter type outside the vocabulary, or machinery in the record. */
export type TypeViolation = {
  file: string;
  declared: string; // the literal `type:` (or offending `kind:`) as written
  expected: string; // what the tree demands
};

export type TypesResult = { checked: number; violations: TypeViolation[] };

/** Sweep references/ + entities/: every item's literal stamped `type:` must
 * match its tree, and no record item may carry `kind: request` (a work
 * order is machinery — intake routes it to the queue, so one in the record
 * is a misfile by definition). A missing `type:` on a reference is
 * grandfathered (pre-stamp arrivals; the landing stamps every new one);
 * entities are editor-written and get no such grace. A dossier's
 * `entity_type:` must come from ENTITY_TYPES (lib/envelope.ts, the SSOT
 * the editor prompt renders from) — present-and-foreign is a violation,
 * absent is tolerated (same grandfathering discipline as everything here).
 * Every reference must carry exactly ONE non-empty `category:` (the rule
 * of 2026-08-05: landing stamps it, the editor may reassign it, nothing
 * may drop or pluralize it) — the vocabulary itself is emergent-open and
 * never checked, only the cardinality. */
export function checkTypes(root: string): TypesResult {
  const res: TypesResult = { checked: 0, violations: [] };
  const sweep = (
    paths: string[],
    expected: "reference" | "entity",
    graceMissing: boolean
  ): void => {
    for (const f of paths) {
      let env;
      try {
        env = parseEnvelope(readFileSync(join(root, f), "utf8")).envelope;
      } catch {
        continue; // unreadable — the link check's tolerance, not a type crime
      }
      res.checked++;
      const declared = typeof env.type === "string" ? env.type.trim() : "";
      if (declared ? declared !== expected : !graceMissing)
        res.violations.push({ file: f, declared: declared || "(none)", expected });
      if (typeof env.kind === "string" && env.kind.trim() === "request")
        res.violations.push({
          file: f,
          declared: "kind: request",
          expected: "routed to the queue, never landed in the record",
        });
      const et = typeof env.entity_type === "string" ? env.entity_type.trim() : "";
      if (expected === "entity" && et && !(ENTITY_TYPES as readonly string[]).includes(et))
        res.violations.push({
          file: f,
          declared: `entity_type: ${et}`,
          expected: ENTITY_TYPES.join(" | "),
        });
      if (expected === "reference" && (typeof env.category !== "string" || !env.category.trim()))
        res.violations.push({
          file: f,
          declared: Array.isArray(env.category) ? "category: (a list)" : "category: (none)",
          expected: "exactly one category — stamped at landing, editor-reassignable",
        });
    }
  };
  sweep(listReferencePaths(root), "reference", true);
  sweep(
    listNotes(root).filter((p) => p.startsWith("entities/")),
    "entity",
    false
  );
  return res;
}

// ── backlink repair on rename/move (#52) ─────────────────────────────────
// Path identity is the price of Obsidian-legal links: a target names a
// location, so moving a note breaks every link that pointed at it. The
// mapping old→new is FREE at the moment of the move and expensive to
// reconstruct afterwards — which is what the repair loop was doing,
// handing a model a dead pointer and asking it to guess the destination.
// Capture the mapping instead (the caller gets it from git's own rename
// detection; every pass commits) and the rewrite is arithmetic.

export type Rename = { from: string; to: string };

export type RenameRepair = {
  rewritten: number;
  filesTouched: number;
  /** bare links matching a rename's OLD basename that another note still
   * answers to — left alone, because which note they meant is a guess */
  contested: Link[];
};

/** Rewrite every inbound link to a renamed or moved note.
 *
 * Two link shapes are followed, and only two:
 *   - a PATH target equal to the old path — unambiguous, always correct;
 *   - a BARE target equal to the old basename, but ONLY when no surviving
 *     note answers to that basename. If one does, the link may well have
 *     meant that one; it lands in `contested` and checkLinks reports it.
 *
 * Honest limit: this follows what git CALLS a rename. A pass that deletes
 * a note and writes a very different one under a new name is a delete plus
 * an add, and the links to it are simply broken — fileLinkRegression's
 * job, as before. */
export function repairRenames(root: string, renames: Rename[], write: boolean, scope: string[] = []): RenameRepair {
  const res: RenameRepair = { rewritten: 0, filesTouched: 0, contested: [] };
  if (!renames.length) return res;
  const notes = listNotes(root);
  const surviving = new Set(notes.map((p) => base(p).toLowerCase()));

  const byPath = new Map<string, string>(); // old path (sans .md, lower) → new path
  const byBase = new Map<string, string>(); // old basename (lower) → new path
  for (const r of renames) {
    byPath.set(r.from.replace(/\.md$/, "").toLowerCase(), r.to);
    const b = base(r.from).toLowerCase();
    // the rename took the last note of that basename → a bare link to it
    // can only have meant this note
    if (!surviving.has(b)) byBase.set(b, r.to);
  }

  for (const f of notes) {
    if (scope.length && !scope.some(p => f === p || f.startsWith(`${p}/`))) continue;
    const text = readFileSync(join(root, f), "utf8");
    const rw = rewriteLinks(text, LINK_RE, (m) => {
      const t = m[1]!.trim();
      const key = t.replace(/\.md$/, "").toLowerCase();
      const dest = key.includes("/") ? byPath.get(key) : byBase.get(key);
      // a bare link naming a rename's old basename that we deliberately
      // did NOT map, because a surviving note still answers to it
      const contested =
        !dest && !key.includes("/") && renames.some((r) => base(r.from).toLowerCase() === key);
      if (contested) {
        res.contested.push({
          file: f,
          line: text.slice(0, m.index).split("\n").length,
          target: t,
          sub: m[2] ?? "",
          label: m[3]?.replace(/\s+/g, " ").trim() ?? null,
        });
        return null;
      }
      if (!dest) return null;
      const label = m[3]?.replace(/^[ \t]+|[ \t]+$/g, "");
      res.rewritten++;
      return `[[${dest.replace(/\.md$/, "")}${m[2] ?? ""}|${label ?? t}]]`;
    });
    if (rw.touched) {
      res.filesTouched++;
      if (write) writeFileSync(join(root, f), rw.text);
    }
  }
  return res;
}

export type MigrateResult = {
  rewritten: number;
  filesTouched: number;
  /** old-dialect links with no date-stripped match — need judgment */
  unmatched: Link[];
  /** old-dialect links matching several dated files — need judgment */
  contested: { link: Link; candidates: string[] }[];
};

/** Bring every link to canonical form: a vault-root path, with the prose the
 * reader used to see preserved as |alias. Two passes in one walk —
 *
 *   resolvable but bare   [[big-brain]] → [[entities/big-brain|big-brain]]
 *   unresolvable          the old date-stripped-slug rescue, now writing
 *                         the full path rather than a bare basename
 *
 * — so a vault migrates from either dialect in one run. Anything with no
 * match or several lands in the report for judgment, never a guess.
 * Dry-run unless write. */
export const migrateLinks = (root: string, write: boolean): MigrateResult =>
  canonicalizeLinks(root, listNotes(root), write);

/** The canonicaliser proper: same rules, but over a GIVEN file list.
 *
 * `migrate` passes the whole vault; the run commit path passes only what
 * a run touched (lib/run/commit.ts), which is what makes `unqualified` and
 * `markdown` unreachable in practice rather than merely reported. Writing
 * a correct path is lookup, not judgment — so the machine does it, and
 * the model is free to write [[ada-lovelace]] and be right anyway.
 *
 * The RESOLUTION index is always the whole vault; only the WALK is
 * scoped. A file may link anywhere regardless of what else changed. */
export function canonicalizeLinks(root: string, files: string[], write: boolean): MigrateResult {
  const notes = listNotes(root);
  const idx = noteIndex([...notes, ...listReferencePaths(root)]);
  const stripped = new Map<string, string[]>();
  for (const p of notes) {
    const k = slug(stripDate(base(p)));
    stripped.set(k, [...(stripped.get(k) ?? []), p]);
  }

  const known = pathIndex([...notes, ...listReferencePaths(root)]);
  const res: MigrateResult = { rewritten: 0, filesTouched: 0, unmatched: [], contested: [] };
  for (const f of files) {
    if (!existsSync(join(root, f))) continue; // deleted mid-run — nothing to canonicalize
    // Scan the WHOLE text, not line by line: the editor hard-wraps prose,
    // so a link's |label routinely spans a newline. A per-line scan skips
    // those silently — 162 of this vault's links on the first dry run —
    // which is a migration that reports success while leaving work behind.
    // maskFences is length-preserving, so a match index in `masked` is the
    // same index in `text` and the splice below lands on the real bytes.
    let text = readFileSync(join(root, f), "utf8");

    // Markdown links FIRST, and in their own scan: converting
    // [Label](note.md) yields an already-canonical [[path|Label]], which
    // the wikilink scan below then leaves alone.
    const md = rewriteLinks(text, MD_LINK_RE, (m) => {
      if (m[1]) return null; // image — points at an asset, not a note
      const resolved = mdTarget(f, m[3]!, known);
      if (!resolved || resolved === f) return null;
      const label = m[2]!.replace(/^[ \t]+|[ \t]+$/g, "");
      res.rewritten++;
      return `[[${resolved.replace(/\.md$/, "")}|${label}]]`;
    });
    text = md.text;

    const wiki = rewriteLinks(text, LINK_RE, (m) => {
      const t = m[1]!.trim();
      const sub = m[2] ?? "";
      // The RAW label, newlines and all — rewriting a target must not
      // reflow the prose around it. Spaces and tabs at the edges are
      // noise and go; a NEWLINE at either edge is the editor's hard wrap
      // ("[[x|\n  Label]]") and stays, or the rewrite silently joins two
      // lines of someone's prose to change a link.
      const label = m[3]?.replace(/^[ \t]+|[ \t]+$/g, "");
      const line = text.slice(0, m.index).split("\n").length;
      const link: Link = {
        file: f,
        line,
        target: t,
        sub,
        label: label?.replace(/\s+/g, " ") ?? null,
      };
      // the alias keeps what the reader SAW before the target grew a
      // path — an explicit label if there was one, else the old target
      const rewrite = (path: string): string => {
        res.rewritten++;
        return `[[${path.replace(/\.md$/, "")}${sub}|${label ?? t}]]`;
      };
      const live = resolve(t, idx);
      if (live.length > 1) {
        res.contested.push({ link, candidates: live });
        return null;
      }
      // resolves today: canonical already, or bare and needing its path
      if (live.length === 1)
        return t === live[0]!.replace(/\.md$/, "") ? null : rewrite(live[0]!);
      const hits = stripped.get(slug(t.replace(/\.md$/, ""))) ?? [];
      if (hits.length === 0) {
        res.unmatched.push(link);
        return null;
      }
      if (hits.length > 1) {
        res.contested.push({ link, candidates: hits });
        return null;
      }
      return rewrite(hits[0]!);
    });
    if (md.touched || wiki.touched) {
      res.filesTouched++;
      if (write) writeFileSync(join(root, f), wiki.text);
    }
  }
  return res;
}
