/** Cursor I/O has no account policy or provider dependencies. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where this integration's cursor lives — one file per integration name,
 * under the vault's own .state/ (never the engine checkout: state is
 * vault-scoped, like everything else under the vault root). */
export function integrationStateFile(name: string, root: string): string {
  return join(root, ".state", `${name}.json`);
}

/** This poller's raw cursor JSON, or undefined — meaning EITHER "never
 * written yet" OR "unreadable" (missing, truncated, not an object): both
 * get the same answer, because both mean the same thing to a caller — a
 * cursor is a cache, so an unreadable one is rebuilt, not fatal. Callers
 * reconstruct their own typed Cursor from the raw fields (each integration
 * has a different shape), applying their own per-field defaults the same
 * way they already do for a first-ever run. */
export function readCursorJson(stateFile: string): Record<string, unknown> | undefined {
  if (!existsSync(stateFile)) return undefined;
  try {
    const c = JSON.parse(readFileSync(stateFile, "utf8"));
    return c && typeof c === "object" ? (c as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
