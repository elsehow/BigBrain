/**
 * references.ts — landing and reading the record's arrival tree,
 * `references/` (grown out of the lake plane, docs/plans/2026-07-25-
 * lake-vault-queue.md phase 1; tree renamed at the 2026-08-04 fresh
 * start, module renamed to match 2026-08-07).
 *
 * The storage model, three layers (the vault README is the user-facing
 * statement; this comment is the engine-facing one):
 *  - THE LAKE — what the world delivered, immutable: `log/insertions/`
 *    contains one exact source event per arrival and the blob CAS
 *    (lib/blobs.ts) holds original binary payloads outside git. Never edited;
 *    a source-side revision is a NEW insertion (envelope `supersedes`).
 *  - PROJECTIONS — queryable views rebuilt from the log. `references/`
 *    (one compatibility file per pre-#496 arrival) and `entities/` (the
 *    retired editor's compression) are frozen history, no longer written.
 *  - MEMORY — `memory/`, the derived working set; memory pass only.
 *
 * Every inbox-bound arrival lands in the native source log only (#496:
 * no new `references/` file is written). Readable flat basenames remain on
 * purpose: entity
 * dossiers [[wikilink]] references by basename. No filing stamps, ever:
 * "where did this get filed" is derived by joining reference id →
 * citing dossiers, not written back. Raw payloads live in the CAS
 * (lib/blobs.ts); the envelope carries `attachments` refs.
 *
 * Exact-dupe short-circuit (issue #1's exact half): the item's sha256 —
 * computed by the front door over the payload as the CLIENT delivered it,
 * BEFORE volatile provenance stamps (received, generated ids), so a
 * byte-identical redelivery hashes the same — keys a small in-memory index
 * (walk-and-refresh on use, appended on write; no daemon); a hash already
 * landed returns the existing item instead of writing a second one.
 *
 * Side-effect-free at import (no manifest.ts) — every function takes `root`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256hex } from "./hash";
import {
  newItemId,
  normalizeType,
  parseEnvelope,
  type AttachmentRef,
  type Envelope,
} from "./envelope";
import { commitPathsOnly, gitLines, gitOut } from "./git";
import {
  appendSourceInsertion,
  INSERTION_LOG_DIR,
  insertionEventRel,
  type SourceInsertion,
} from "./insertionLog";
import {
  openAssertionProjectionReadonly,
  projectSourceInsertion,
  syncAssertionProjection,
} from "./assertionProjection";

/** The record tree's name. One constant on purpose: legacy vaults with a
 * `lake/` tree are frozen archives — the engine reads and writes only this. */
export const REFERENCES_DIR = "references";

export interface Landing {
  /** Vault-relative path of the immutable insertion event
   * (`log/insertions/<month>/<id>.json`) — the readable record of the
   * arrival, served by every note door. #496: the `references/*.md`
   * compatibility projection is no longer written; existing files are
   * frozen history. */
  path: string;
  id: string;
  sha256: string;
  title?: string;
  /** An item with this sha256 had already landed — nothing was written. */
  deduped: boolean;
  /** Immutable insertion identity. */
  insertionId: string;
}

/** Every `references/**.md` file, as {vault-relative path, absolute path}
 * pairs — the one directory walk shared by shaIndex, listReferencePaths, and
 * listReferenceItems below. Recursive: the tree is flat by construction, but a
 * hand-arranged subdirectory must not hide items from the record. */
function* walkReferences(
  root: string,
  rel: string = REFERENCES_DIR
): Generator<{ rel: string; abs: string }> {
  const abs = join(root, rel);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return; // no record tree yet
  }
  for (const e of entries) {
    if (e.isDirectory()) yield* walkReferences(root, `${rel}/${e.name}`);
    else if (e.name.endsWith(".md")) yield { rel: `${rel}/${e.name}`, abs: join(abs, e.name) };
  }
}

/** Vault-relative paths of every reference — the frozen compatibility
 * corpus, alongside the notes lib/links.ts's listNotes walks. */
export function listReferencePaths(root: string): string[] {
  return [...walkReferences(root)].map((x) => x.rel).sort();
}

export interface ReferenceItem {
  path: string; // vault-relative, references/<file>.md
  envelope: Envelope;
  mtimeMs: number;
  /** The item's opening words (see firstLine) — enough to identify it when
   * its TITLE can't. An annotation's title is "Note on: <the subject>", so
   * a feed that nests it under that subject would otherwise render a row
   * whose every word is already on the line above. */
  excerpt?: string;
}

/** The first line of prose in a body, capped — skipping blanks, markdown
 * headings, and the frontmatter-adjacent noise a body sometimes opens
 * with. Truthful truncation: an ellipsis only when something was cut. */
function firstLine(body: string, cap = 120): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line === "---") continue;
    return line.length > cap ? `${line.slice(0, cap - 1).trimEnd()}…` : line;
  }
  return "";
}

/** Every reference with its parsed envelope — the web viewer's /api/recent
 * direct-read path (docs/plans/2026-07-25-lake-vault-queue.md, phase 1
 * "visibility"). A fresh filesystem read every call, not the shaIndex cache
 * above: the feed wants this-second freshness, and references are cheap to
 * re-read (no attachments ride in the text). */
export function listReferenceItems(root: string): ReferenceItem[] {
  const out: ReferenceItem[] = [];
  for (const { rel, abs } of walkReferences(root)) {
    try {
      // The body was already parsed to find the envelope; keeping one line
      // of it costs nothing and is the only way a nested row can say
      // anything (see ReferenceItem.excerpt).
      const { envelope, body } = parseEnvelope(readFileSync(abs, "utf8"));
      const excerpt = firstLine(body);
      out.push({
        path: rel,
        envelope,
        mtimeMs: statSync(abs).mtimeMs,
        ...(excerpt ? { excerpt } : {}),
      });
    } catch {
      /* unreadable item — skip, matches shaIndex's tolerance */
    }
  }
  return out;
}

/** id → reference path, one fresh walk per call — the join key for "where did
 * this get filed" (citing vault notes name reference ids in `sources:`) and for
 * resolving a queue message's reference refs. Shared by the worker's ref
 * resolution and the citation check (lib/links.ts checkSources). */
export function referenceIdMap(root: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of listReferenceItems(root)) {
    if (typeof item.envelope.id === "string" && item.envelope.id)
      map.set(item.envelope.id, item.path);
  }
  return map;
}

/** The dedup lookup: has an item with this pre-stamp sha256 already landed?
 * Answered from the assertion projection's sources table (the stamped
 * envelope carries `sha256`), synced incrementally first — so an item
 * landed by ANOTHER process (the one-shot ssh path vs the long-lived API
 * server) still dedupes here, and a fresh vault answers from an empty
 * projection rather than a directory walk. Best-effort by design: a write
 * racing between sync and land can still slip a dupe in, and a projection
 * failure must never refuse a landing (worst case an exact dupe lands
 * twice — both immutable, both citing the same source).
 *
 * References-tree walking is GONE from this path (#496): frozen
 * `references/*.md` predating the native flip were imported into the
 * insertion log at promotion, so the log answers for them too. */
function landedBySha(root: string, sha256: string): SourceInsertion | undefined {
  try {
    syncAssertionProjection(root);
    const db = openAssertionProjectionReadonly(root);
    try {
      const row = db.query(
        "SELECT event_json FROM sources WHERE json_extract(event_json, '$.envelope.sha256') = ? LIMIT 1"
      ).get(sha256) as { event_json: string } | null;
      return row ? (JSON.parse(row.event_json) as SourceInsertion) : undefined;
    } finally { db.close(); }
  } catch {
    return undefined;
  }
}

export interface LandOpts {
  attachments?: AttachmentRef[];
  now?: Date;
  /** The item's dedup identity, computed by the front door over the
   * pre-stamp payload (lib/intake.ts). Defaults to sha256 of `content` —
   * only right for callers whose content carries no volatile stamps. */
  sha256?: string;
}

/** Land one item as an insertion event (#496 — no references/ file). `content` is the full item text as delivered
 * (reserved keys already stripped/stamped by the front door); its identity
 * is `opts.sha256` — the front door's hash of the PRE-stamp payload — or,
 * absent that, the sha256 of `content` itself. The envelope gains `sha256`,
 * a `received` timestamp (kept when the front door already stamped one), an
 * `id` when absent, and the attachment refs. Intake never edits this
 * file again — the landing commit freezes the arrival; any later change
 * is the editor's (record-side, journaled). */
export function landReference(root: string, content: string, opts: LandOpts = {}): Landing {
  const sha256 = opts.sha256 ?? sha256hex(content);
  const existing = landedBySha(root, sha256);
  if (existing) {
    const env = existing.envelope;
    const rel = insertionEventRel(existing);
    return {
      path: rel,
      id: existing.source_id,
      sha256,
      ...(env["title"] ? { title: String(env["title"]) } : {}),
      insertionId: existing.id,
      deduped: true,
    };
  }

  const { envelope, body } = parseEnvelope(content);
  const now = opts.now ?? new Date();
  const received =
    typeof envelope.received === "string" && /^\d{4}-\d{2}/.test(envelope.received)
      ? envelope.received
      : now.toISOString();
  const id = typeof envelope.id === "string" && envelope.id ? envelope.id : newItemId("api", now);

  // Substrate type + the ONE category (drop-zone cut 3; category rule
  // 2026-08-05): normalize to the STRONG two-type vocabulary — declared
  // value kept, flavor words folded into tags, bare drops default
  // `reference` — and stamp exactly one `category:` (front door's flavor →
  // first tag → source → "drop") — mechanical, never a model call. Stamped
  // here so every reference is self-describing and file-time-valid from
  // the moment it lands, on both front doors and the importer alike. The editor
  // may later reassign `category:` — the one post-landing frontmatter
  // change the record admits.
  const norm = normalizeType(envelope);
  const env: Envelope = {
    ...envelope,
    id,
    received,
    sha256,
    type: norm.type,
    category: norm.category,
    ...(norm.tags.length ? { tags: norm.tags } : {}),
  };
  if (opts.attachments?.length) env.attachments = opts.attachments;

  // The source log is the ONE durable write (#496): the immutable insertion
  // event, idempotent by its deterministic id. The projection row lands
  // eagerly (O(1)) so search and the next dedup see it without a sync;
  // fail-soft — a projection hiccup heals on the next sync and must never
  // fail the landing.
  const insertion = appendSourceInsertion(root, env as Envelope & Record<string, unknown>, body);
  try {
    projectSourceInsertion(root, insertion.event);
  } catch (error) {
    console.error(`intake: source projection failed (the event is safe in the log): ${error}`);
  }
  return {
    path: insertion.path,
    id,
    sha256,
    ...(envelope.title ? { title: String(envelope.title) } : {}),
    insertionId: insertion.event.id,
    deduped: false,
  };
}

/** The append-only paths a landing commit may carry: the reference and native
 * insertion event that just landed, plus every OTHER uncommitted ADDITION
 * under those trees — an orphan from an earlier fail-soft commit.
 *
 * Never a modification, never a deletion. Intake writes a reference once and
 * never touches it again — the landing commit freezes the arrival — so a
 * CHANGED tracked file under references/ is by construction not intake's, and
 * must not ride an intake-authored commit.
 *
 * That is #216, and it is why the pathspec cannot simply be REFERENCES_DIR.
 * `git commit --only -- references` commits the working-tree state of the
 * whole tree, so a third party's edit to an unrelated reference rode the next
 * landing commit, mis-authored `intake`. Worse, it rode it BEFORE the editor
 * ran: commitLanding is on the arrival path, the tripwire (#127) is on the
 * pass, so by the time the tripwire looked the tree was already clean and the
 * foreign write was laundered into history with nothing flagged. Reproduced on
 * staging 2026-08-12.
 *
 * Splitting on addition-vs-modification keeps both properties: the orphan
 * sweep the whole-tree pathspec existed for, and a landing commit that cannot
 * carry someone else's edit. */
function landingPaths(root: string, landingPath: string): string[] {
  const additions = gitLines(root, ["status", "--porcelain", "--", INSERTION_LOG_DIR])
    .filter((l) => l.startsWith("??") || l.startsWith("A"))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  return [...new Set([landingPath, ...additions])];
}

/** Commit a landing as author `intake` — the immutable source event
 * (#496: no compatibility reference rides along any more). A
 * PARTIAL commit (commitPathsOnly),
 * never a whole-index one: intake holds no lock over the repo, and the
 * memory pass may have work staged mid-run — a plain commit
 * here would sweep that staged work into an intake-authored commit and
 * empty the index under it. Carries the landed file
 * and any orphaned earlier landing (landingPaths — additions only, never a
 * foreign edit), plus any `alsoStage` trees the caller wrote in the same
 * breath.
 * Fail-soft by contract: a commit failure (concurrent index lock, whatever)
 * must never roll back or fail the landing — log loudly and move on. */
export function commitLanding(root: string, landing: Landing, alsoStage: string[] = []): void {
  if (!gitOut(root, ["rev-parse", "--git-dir"])) return; // not a repo (scratch vault) — nothing to record
  try {
    const paths = [...landingPaths(root, landing.path), ...alsoStage];
    commitPathsOnly(
      root,
      "intake",
      `intake: ${landing.id}${landing.title ? ` — ${landing.title}` : ""}`,
      paths
    );
  } catch (e) {
    console.error(
      `intake: landing commit failed (${landing.path} is safe on disk; the next landing commit sweeps it): ${e}`
    );
  }
}
