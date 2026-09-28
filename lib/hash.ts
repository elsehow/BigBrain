/** sha256, hex. The one spelling.
 *
 * Content addressing is how this vault says "the same thing": an insertion
 * id, an assertion id, a blob's name, a landed reference's dedup key, a
 * token's stored digest. Eight modules had opened `node:crypto` to write the
 * same line, and lib/memoryRun.ts imported the whole reference-writing module
 * to reach the copy that lived there.
 */

import { createHash } from "node:crypto";

export const sha256hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
