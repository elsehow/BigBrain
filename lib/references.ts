/**
 * references.ts — landing an arrival in the record: one immutable insertion
 * event in `log/insertions/` (#496), its raw payloads in the blob CAS
 * (lib/blobs.ts; the envelope carries `attachments` refs), committed as
 * author `intake`. The module keeps the name of the `references/` tree it
 * once wrote; `bigbrain migrate` imported what that tree held and removed it
 * (docs/plans/2026-10-11-field-of-assertions.md, migration 3).
 *
 * Exact-dupe short-circuit (issue #1's exact half): the item's sha256 —
 * computed by the front door over the payload as the CLIENT delivered it,
 * BEFORE volatile provenance stamps (received, generated ids), so a
 * byte-identical redelivery hashes the same — is looked up in the
 * projection's sources; a hash already landed returns the existing item
 * instead of writing a second one.
 *
 * Side-effect-free at import (no manifest.ts) — every function takes `root`.
 */

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

export interface Landing {
  /** Vault-relative path of the immutable insertion event
   * (`log/insertions/<month>/<id>.json`) — the readable record of the
   * arrival, served by every note door. */
  path: string;
  id: string;
  sha256: string;
  title?: string;
  /** An item with this sha256 had already landed — nothing was written. */
  deduped: boolean;
  /** Immutable insertion identity. */
  insertionId: string;
}

/** The dedup lookup: has an item with this pre-stamp sha256 already landed?
 * Answered from the assertion projection's sources table (the stamped
 * envelope carries `sha256`), synced incrementally first — so an item
 * landed by ANOTHER process (the one-shot ssh path vs the long-lived API
 * server) still dedupes here, and a fresh vault answers from an empty
 * projection rather than a directory walk. Best-effort by design: a write
 * racing between sync and land can still slip a dupe in, and a projection
 * failure must never refuse a landing (worst case an exact dupe lands
 * twice — both immutable, both citing the same source). */
function landedBySha(root: string, sha256: string): SourceInsertion | undefined {
  try {
    syncAssertionProjection(root);
    const db = openAssertionProjectionReadonly(root);
    try {
      const row = db.query(
        "SELECT event_json FROM sources JOIN source_documents USING (insertion_id) WHERE envelope_sha256 = ? LIMIT 1"
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

/** Land one item as an insertion event (#496). `content` is the full item text as delivered
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
  // fail-soft — a projection hiccup heals at the next recovery and must never
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

/** The append-only paths a landing commit may carry: the insertion event
 * that just landed, plus every OTHER uncommitted ADDITION under
 * `log/insertions/` — an orphan from an earlier fail-soft commit.
 *
 * Never a modification, never a deletion (#216): a whole-tree pathspec
 * commits the working-tree state of the whole tree, so a third party's edit
 * rode the next landing commit, mis-authored `intake`, before any tripwire
 * could see it. Splitting on addition-vs-modification keeps the orphan sweep
 * and a landing commit that cannot carry someone else's edit. */
function landingPaths(root: string, landingPath: string): string[] {
  const additions = gitLines(root, ["status", "--porcelain", "--", INSERTION_LOG_DIR])
    .filter((l) => l.startsWith("??") || l.startsWith("A"))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  return [...new Set([landingPath, ...additions])];
}

/** Commit a landing as author `intake` — the immutable source event
 * — a PARTIAL commit (commitPathsOnly),
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
