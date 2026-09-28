/**
 * blobs.ts — the private CAS for landed payloads (docs/plans/2026-07-25-lake-
 * vault-queue.md, phase 1 "payload store"). Layout:
 * `<root>/.blobs/sha256/<first-2-hex>/<full-hex>` — gitignored, host-
 * canonical, covered by the host's file backup rather than git.
 *
 * Every function takes `root` as a parameter rather than reaching for
 * VAULT_ROOT — the rule for a `lib/` module, since it may be running
 * against a scratch vault or a test fixture. Content addressing gives
 * exact-dedup for free (issue #1) and
 * turns redaction (#2) into a real filesystem delete, not a tombstone.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256hex } from "./hash";
import { writeAtomic } from "./fsx";

const SHA256_RE = /^[0-9a-f]{64}$/;

/** The ONE blob-link representation a reference's body ever carries —
 * `blob:<sha256>` (lib/envelope.ts's AttachmentRef doc comment) — as it
 * rides raw inside a markdown link/image target. Resolvers (the web
 * viewer's /api/file) parse it with this, never a second ad-hoc regex. */
const BLOB_REF_RE = /^blob:([0-9a-f]{64})$/;

/** The sha256 out of a `blob:<sha256>` ref, or null for anything else
 * (a real vault-relative path, a malformed/garbage ref). */
export function parseBlobRef(ref: string): string | null {
  return BLOB_REF_RE.exec(ref)?.[1] ?? null;
}

/** Reject anything that isn't a bare lowercase hex sha256 before it touches
 * a path — the path-traversal guard. An invalid key is a caller bug, so
 * this throws rather than returning a miss. */
function requireValidSha256(sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new Error(`blobs: invalid sha256 ${JSON.stringify(sha256)}`);
  return sha256;
}

function blobDir(root: string, sha256: string): string {
  return join(root, ".blobs", "sha256", sha256.slice(0, 2));
}

function blobFile(root: string, sha256: string): string {
  return join(blobDir(root, sha256), sha256);
}

export interface PutResult {
  sha256: string;
  bytes: number;
  existed: boolean;
}

/** Write bytes into the CAS, keyed by their own sha256. Atomic (fsx.ts's
 * temp-file-then-rename) and idempotent: identical bytes already present is
 * a no-op — `existed: true` rather than a second write. */
export function putBlob(root: string, bytes: Uint8Array): PutResult {
  const sha256 = sha256hex(bytes);
  const dest = blobFile(root, sha256);
  if (existsSync(dest)) return { sha256, bytes: bytes.byteLength, existed: true };
  writeAtomic(dest, Buffer.from(bytes));
  return { sha256, bytes: bytes.byteLength, existed: false };
}

/** Absolute path to a stored blob, or null if absent. */
export function getBlobPath(root: string, sha256: string): string | null {
  const dest = blobFile(root, requireValidSha256(sha256));
  return existsSync(dest) ? dest : null;
}

export function hasBlob(root: string, sha256: string): boolean {
  return getBlobPath(root, sha256) !== null;
}

export function readBlob(root: string, sha256: string): Buffer | null {
  const path = getBlobPath(root, sha256);
  return path ? readFileSync(path) : null;
}

/** A real filesystem delete — the redaction path (#2), not a tombstone.
 * Returns whether a blob was actually removed. */
export function deleteBlob(root: string, sha256: string): boolean {
  const path = getBlobPath(root, sha256);
  if (!path) return false;
  rmSync(path);
  return true;
}
