/** Pending integration data and source checkpoints survive cache deletion.
 * They stay local, including in vaults whose generated .gitignore predates
 * this store. Backups must include .spool alongside .blobs. */
import { join } from "node:path";
import { createAtomic } from "./fsx";

export const spoolDir = (root: string): string => join(root, ".spool");

export function ensureSpool(root: string): void {
  createAtomic(join(spoolDir(root), ".gitignore"), "*\n");
}
