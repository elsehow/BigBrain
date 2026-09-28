/**
 * blob.ts — follow a `blob:<sha256>` link to actual bytes (#59). The
 * reading contract: every reference is the record's ingestable
 * understanding of an arrival, and it LINKS to the lake — this verb is the
 * follow-through, so an agent can open the original PDF and look at
 * figure 3 rather than settling for the extraction.
 *
 *   bigbrain blob path <sha|blob:sha>   # resolve to a local file path
 *
 * Pure local lookup — the CAS lives beside the vault (the cache can never
 * be stale: content addressing). Only the path goes to stdout; notes go to
 * stderr, so `$(bigbrain blob path <sha>)` composes.
 */

import { VAULT_ROOT } from "../lib/vaultRoot";
import { getBlobPath, parseBlobRef } from "../lib/blobs";

const [cmd, refArg] = process.argv.slice(2);

function usage(code: number): never {
  console.error("usage: bigbrain blob path <sha256 | blob:sha256>");
  process.exit(code);
}

if (cmd !== "path") usage(cmd ? 2 : 0);
if (!refArg) usage(2);

const sha = parseBlobRef(refArg) ?? (/^[0-9a-f]{64}$/.test(refArg) ? refArg : null);
if (!sha) {
  console.error(
    `blob: ${JSON.stringify(refArg)} is not a blob ref — pass the 64-hex sha256, bare or as blob:<sha256>`
  );
  process.exit(2);
}

const local = getBlobPath(VAULT_ROOT, sha);
if (local) {
  console.log(local);
  process.exit(0);
}

console.error(`blob: ${sha} is not in the CAS — redacted (deleted), or never landed here`);
process.exit(1);
