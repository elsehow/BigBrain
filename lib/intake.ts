/** Intake validates discussable text, stores attachments, and appends one
 * immutable source insertion. Its receipt always names that readable event. */

import { putBlob } from "./blobs";
import { newItemId, type AttachmentRef } from "./envelope";
import { splitNote, stampNote, yscalar } from "./fsx";
import { sha256hex } from "./hash";
import { commitLanding, landReference } from "./references";

/** The ITEM-TEXT cap only. Item text lands in the insertion log and its
 * compatibility reference, entering the git history
 * forever — that permanence is the whole
 * case for a cap. Attachments are deliberately UNCAPPED (2026-08-06):
 * they live in the gitignored, content-addressed blob store — add-only
 * disk, not history — so size costs the host, never the record. */
export const MAX_BYTES = 10 * 1024 * 1024;

export type IntakeErrorCode = "empty" | "too-large";

export class IntakeError extends Error {
  code: IntakeErrorCode;
  constructor(code: IntakeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A binary riding along with an item (an image, an original PDF…) —
 * base64 on the wire, landed in the CAS (lib/blobs.ts) and linked from the
 * item's body as `blob:<sha256>` (the representation lib/envelope.ts
 * documents on AttachmentRef). */
export interface Attachment {
  name: string;
  b64: string;
}

/** Extensions that are ALWAYS an attachment, sniff or no sniff — formats a
 * utf8 read would destroy or that nobody means as note text (svg is text on
 * disk but an image in intent). The complement is NOT "text": an unknown
 * extension falls through to the null-byte sniff below. */
const ATTACH_EXT =
  /\.(pdf|png|jpe?g|gif|webp|heic|svg|mp3|m4a|wav|ogg|flac|aiff?|mp4|mov|avi|mkv|webm|zip|gz|tgz|tar|7z|docx?|xlsx?|pptx?|epub|sqlite|db)$/i;
const TEXT_EXT = /\.(md|markdown|txt)$/i;

/** Should this file ride as an attachment (bytes → CAS) rather than as the
 * item's text? The #57 gate that keeps `drop paper.pdf` from inhaling binary
 * as mangled utf8. Extension first (both directions), then a null-byte
 * sniff over the head of the payload for the unknowns. */
export function looksBinary(name: string, bytes: Uint8Array): boolean {
  if (ATTACH_EXT.test(name)) return true;
  if (TEXT_EXT.test(name)) return false;
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export interface ReceiveItemOpts {
  root: string;
  content: string;
  /** The payload as the CLIENT delivered it, BEFORE the front door's
   * provenance stamps (stampIntake's `received`/generated id, ensureItemId's
   * id). The landing exact-dupe identity hashes THIS — stamps are volatile,
   * so hashing `content` would make byte-identical redeliveries land twice.
   * Defaults to `content` (right only for stamp-free callers, e.g. tests). */
  raw?: string;
  attachments?: Attachment[];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|svg)$/i;

/** The ONE way an attachment appears in an item's body — `[name](blob:<sha>)`,
 * image-embedded for image extensions. */
export function blobLink(name: string, sha256: string): string {
  return `${IMAGE_EXT.test(name) ? "!" : ""}[${name}](blob:${sha256})`;
}

// Attachment MIME values are stored in immutable envelopes.
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  json: "application/json",
  csv: "text/csv",
};
const mimeFor = (name: string): string =>
  MIME[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";

export interface IntakeReceipt {
  /** Stable source identity, including on a duplicate submission. */
  id: string;
  insertionId: string;
  /** Vault-relative path of the immutable insertion event. */
  path: string;
  deduped: boolean;
}

/** Land one item. The insertion event is the durable side effect (#496 — no
 * references/ projection); a dedup hit (#136) suppresses it. */
export function receive(opts: ReceiveItemOpts): IntakeReceipt {
  const { root, attachments = [] } = opts;
  let content = opts.content;
  let raw = opts.raw ?? opts.content;
  if (!content.trim()) throw new IntakeError("empty", "empty item — nothing landed");

  // Attachments first, so the item text can link them. They land in the
  // CAS keyed by their own sha256; the body links `blob:<sha256>` and the
  // reference's envelope carries the full refs. (An orphan blob from a later
  // refusal is harmless — content-addressed, reclaimed by any future put.)
  // UNBOUNDED by size (Nick's rule, 2026-08-06): the CAS is the vault's
  // add-only object store — gitignored, content-addressed, never in the
  // git history — so a big scan costs disk, not the
  // record. Only the item TEXT below is capped: that lands in
  // the insertion log and rides git forever.
  const attRefs: AttachmentRef[] = [];
  if (attachments.length) {
    const links: string[] = [];
    for (const att of attachments) {
      const clean = (att.name || "attachment").replace(/[/\\]/g, "_").replace(/^\.+/, "_");
      const buf = Buffer.from(att.b64, "base64");
      const put = putBlob(root, buf);
      attRefs.push({ name: clean, sha256: put.sha256, bytes: put.bytes, mime: mimeFor(clean) });
      links.push(blobLink(clean, put.sha256));
    }
    content = `${content.replace(/\n+$/, "")}\n\n${links.join("\n\n")}\n`;
    // the dedup identity sees the same links: same text + different
    // attachments must hash differently
    raw = `${raw.replace(/\n+$/, "")}\n\n${links.join("\n\n")}\n`;
  }

  if (Buffer.byteLength(content) > MAX_BYTES)
    throw new IntakeError("too-large", `item exceeds ${MAX_BYTES} bytes — refused`);

  const landing = landReference(root, content, { attachments: attRefs, sha256: sha256hex(raw) });
  if (!landing.deduped) commitLanding(root, landing);
  return {
    id: landing.id,
    insertionId: landing.insertionId,
    path: landing.path,
    deduped: landing.deduped,
  };
}

/** The local path's ONE stamp: an `id` when the item carries none — identity
 * is required downstream (the reference path, triage's move-detection), and
 * bin/drop.ts stamps nothing else. Same id shape as the HTTP path
 * (stampIntake), prefix `ssh` (the historic spelling of the unstamped
 * door, kept so ids stay stable). Items that already carry an id (every
 * integration's do) pass through byte-identical. */
export function ensureItemId(content: string, now?: Date): string {
  const { fm } = splitNote(content);
  if (/^['"]?id['"]?\s*:/m.test(fm)) return content;
  return stampNote(content, [["id", newItemId("ssh", now ?? new Date())]]);
}

// An arrival never spawns anything. A direct spawn bypasses the scheduler,
// so a disabled timer did not actually stop runs and the timer had to be
// the ONE switch (drop-zone cut 3): the item is safe in the insertion log,
// and the next sweep picks it up. The `poke` flag that said so — a no-op
// since 2026-08-10 — went on 2026-08-30 with the last callers that set it.

// ---------------------------------------------------------------------------
// Provenance stamping — the HTTP path's half. `source`, `submitted_by`,
// `submitted_via`, and `received` are RESERVED: written by code from the
// verified credential, never trusted from the payload (same rule as the
// runner-stamped `filed`/`triage_run` in the retired editor runner).

const RESERVED_KEYS = ["source", "submitted_by", "submitted_via", "received", "from", "from_kind"];

/** Strip top-level occurrences of the given keys from a raw frontmatter
 * block, including their continuation lines — indented block scalars AND
 * column-0 sequence items (`key:\n- a` is valid YAML) — so a crafted value
 * can't leave orphan lines that smuggle a forged key past the stamps. */
export function stripFmKeys(fm: string, keys: string[]): string {
  const keyRe = new RegExp(`^(?:['"]?)(${keys.join("|")})(?:['"]?)\\s*:`);
  const out: string[] = [];
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!keyRe.test(lines[i]!)) {
      out.push(lines[i]!);
      continue;
    }
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || /^-(\s|$)/.test(lines[i + 1]!)))
      i++;
  }
  return out.join("\n");
}

export interface StampOpts {
  tokenId: string;
  tokenName: string;
  /** Provenance `source` value; defaults to "api" (the token-authed HTTP
   * path). The edge-authed web drop stamps "web". */
  source?: string;
  /** The credential's principal: who this item is FROM. A person's verified
   * identity (token owner, edge email) or an agent token's name. */
  from?: string;
  fromKind?: "person" | "agent";
  now?: Date;
}

/** Server-side provenance for an HTTP-submitted item: force the reserved
 * keys from the verified token, generate an `id` when the client sent
 * none (triage's move-detection matches by id), pass everything else —
 * frontmatter and body — through untouched. Conformance beyond that is
 * triage's business, exactly as on the ssh path.
 *
 * Identity rule: a payload may claim to be an AGENT, never a person. A
 * person's `from:` comes only from the verified credential (token owner,
 * edge email); an agent's may be self-asserted through any credential —
 * the shared laptop token carries both the owner's web drops and their
 * agents' composed ones, and only the composer knows which. A payload
 * claiming `from_kind: person` is stripped like any forged reserved key. */
export function stampIntake(content: string, opts: StampOpts): string {
  const { fm, body } = splitNote(content);
  // Identity claim: read line-wise, deliberately NOT parseEnvelope — a
  // payload isn't guaranteed valid YAML, and a well-formed claim must
  // survive a malformed line elsewhere in the block (same tolerance as the
  // runner's kind/pass sniffs). Agent-or-nothing, per the rule above.
  const claimedKind = /^from_kind:\s*["']?agent["']?\s*$/m.exec(fm);
  const claimedFrom = claimedKind
    ? /^from:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm)?.[1]?.trim()
    : undefined;
  const stripped = stripFmKeys(fm, RESERVED_KEYS).replace(/\n+$/, "");
  const lines = stripped.trim() ? stripped.split("\n") : [];

  const now = opts.now ?? new Date();
  if (!lines.some((l) => /^id\s*:/.test(l))) lines.push(`id: ${newItemId("api", now)}`);
  lines.push(`source: ${yscalar(opts.source ?? "api")}`);
  const from = claimedFrom ?? opts.from;
  const fromKind = claimedFrom ? "agent" : opts.fromKind;
  if (from && fromKind) {
    lines.push(`from: ${yscalar(from)}`);
    lines.push(`from_kind: ${fromKind}`);
  }
  lines.push(`submitted_by: ${yscalar(opts.tokenId)}`);
  lines.push(`submitted_via: ${yscalar(opts.tokenName)}`);
  lines.push(`received: ${now.toISOString()}`);

  return ["---", ...lines, "---", "", body.replace(/^\n+/, "")].join("\n");
}
