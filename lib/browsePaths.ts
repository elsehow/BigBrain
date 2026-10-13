/** The viewer's allowed content trees and lexical path containment.
 * File-reading doors also enforce their own realpath and extension checks. */

import { join, relative, resolve, sep } from "node:path";

// The one markdown tree a vault keeps beside its logs: the memory working set.
export const BROWSE_ROOTS = new Set(["memory"]);

/** The markdown the projection holds: the browsed trees, plus the run
 * journals' reports, which a reader opens by path (lib/noteRead.ts
 * READ_TREES) but nothing browses or draws. */
export const NOTE_ROOTS: ReadonlySet<string> = new Set([...BROWSE_ROOTS, "journal"]);

/** Resolve a tree-relative path, or null if it escapes / isn't allowed.
 * `trees` defaults to BROWSE_ROOTS (the viewer's jail); lib/api.ts passes its
 * own narrower allowlist, whose entries may be nested (`inbox/unsorted`) — an
 * entry admits itself and everything under it. Purely lexical: the API door
 * pairs it with a realpath re-check to defeat symlinks. */
export function withinRoot(
  root: string,
  rel: string,
  trees: Iterable<string> = BROWSE_ROOTS
): string | null {
  if (!rel || rel.startsWith("/")) return null;
  const abs = resolve(join(root, rel));
  const norm = relative(root, abs).split(sep).join("/");
  if (!norm) return null;
  for (const t of trees) if (norm === t || norm.startsWith(`${t}/`)) return abs;
  return null;
}

