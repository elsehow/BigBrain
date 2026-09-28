import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
/** Existing hard links cannot be safely attributed to a project boundary.
 * Refuse them; never grant an alternate pathname to an outside inode. */
export function protectedProjectPaths(roots: string[]): string[] {
  const protectedPaths: string[] = [];
  let entries = 0;
  const walk = (path: string) => {
    if (++entries > 250_000) throw new Error("Project scope is too large to inspect safely. Choose a narrower directory.");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return; // The OS sandbox checks the target.
    if (stat.isFile() && stat.nlink > 1) throw new Error("Project scope contains hard-linked files. Use an independent checkout or copy.");
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(path)) {
      const child = join(path, name), key = name.toLowerCase();
      if (key === ".env" || key.startsWith(".env.") || [".ssh", ".aws", ".claude", ".codex", ".pi", "auth.json"].includes(key)) protectedPaths.push(child);
      else walk(child);
    }
  };
  for (const root of roots) walk(root);
  return protectedPaths;
}
