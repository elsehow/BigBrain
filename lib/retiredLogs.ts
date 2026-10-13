/** The logs the assertion kinds replaced (lib/assertionLog.ts), which
 * `bigbrain migrate` converts (lib/migrate.ts), and the trees from before the
 * insertion log (#496), whose arrivals it imports as sources. The engine reads
 * neither: a vault that still holds one is refused until it is migrated
 * (docs/design-principles.md §5). */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { walkMarkdown } from "./vaultRead";

export const RETIRED_LOGS = [
  "log/declines", "log/revocations", "log/entity-aliases", "log/entity-sources", "log/source-copies", "log/entity-fold-rejects",
] as const;
/** Logs nothing ever read, which `bigbrain migrate` deletes. */
export const UNREAD_LOGS = ["log/attestations", "log/goal-assertions"] as const;
/** `references/` and `inbox/` held arrivals, `requests/` the owner's requests
 * and `entities/` the retired editor's dossiers. */
export const RETIRED_TREES = ["references", "inbox", "requests", "entities"] as const;

/** How many files a vault-relative directory holds, at any depth. */
export function fileCount(root: string, dir: string): number {
  const walk = (at: string): number => readdirSync(at, { withFileTypes: true })
    .reduce((n, entry) => n + (entry.isDirectory() ? walk(join(at, entry.name)) : 1), 0);
  return existsSync(join(root, dir)) ? walk(join(root, dir)) : 0;
}

/** Refuse a vault that still holds a retired log, or a note in a retired
 * tree: reading it as if it were absent would lose what it says. (A tree
 * holding only a `.gitkeep` says nothing.) */
export function refuseRetired(root: string): void {
  const held = [
    ...RETIRED_LOGS.filter((dir) => fileCount(root, dir) > 0),
    ...RETIRED_TREES.filter((tree) => walkMarkdown(root, [tree], { cap: 1 }).length > 0),
  ];
  if (held.length) throw new Error(`This vault still holds ${held.join(", ")}, which this BigBrain no longer reads. `
    + "Run `bigbrain migrate` to see what migrating changes, then `bigbrain migrate --yes`.");
}
