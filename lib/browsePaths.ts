/** The viewer's allowed content trees and lexical path containment.
 * File-reading doors also enforce their own realpath and extension checks. */

import { join, relative, resolve, sep } from "node:path";

// Legacy content trees remain readable alongside native log projections.
export const BROWSE_ROOTS = new Set([
  "entities",
  "references",
  "inbox",
  "requests",
  "lake",
  "memory",
]);

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

