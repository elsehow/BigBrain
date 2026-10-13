/**
 * fieldDigest.ts — what a vault reads as, in one hash (lib/fieldDigest.ts).
 * A refactor proves itself by leaving this unchanged on a scratch copy of a
 * vault; a behaviour change explains how it moved.
 *
 *   bun run field:digest <scratch copy of a vault>
 *
 * It may bring the copy's projection up to date, which writes its `.state/`:
 * never point it at a vault an engine is tending.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fieldDigest } from "../lib/fieldDigest";

const [vault] = process.argv.slice(2);
if (!vault || !existsSync(join(vault, "vault.yaml"))) {
  console.error("usage: bun run field:digest <scratch copy of a vault>  (a directory holding vault.yaml)");
  process.exit(2);
}
console.log(JSON.stringify(fieldDigest(resolve(vault)), null, 2));
