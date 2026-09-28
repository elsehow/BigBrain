/** Recovery follows host-observed memory edits, never a whole-vault git diff.
 * Restore the pre-run bytes only while the path still contains our last write. */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { machinePath } from "./run/machineTools";
import { writeAtomic } from "./fsx";
export class MemoryEdits {
  private edits = new Map<string, { before: string | null; after: string | null }>();
  constructor(private root: string) {}
  private read(path: string): string | null {
    const full = machinePath(this.root, path, true);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  }
  capture<T>(paths: string[], mutate: () => T): T {
    for (const path of paths) {
      const current = this.read(path), previous = this.edits.get(path);
      if (previous && current !== previous.after) throw new Error(`Memory changed outside this run: ${path}`);
      if (!previous) this.edits.set(path, { before: current, after: current });
    }
    try { return mutate(); }
    finally { for (const path of paths) this.edits.get(path)!.after = this.read(path); }
  }
  rollback(): string[] {
    const conflicts: string[] = [];
    for (const [path, edit] of this.edits) {
      try {
        if (this.read(path) !== edit.after) { conflicts.push(path); continue; }
        const full = machinePath(this.root, path, true);
        if (edit.before === null) { if (existsSync(full)) unlinkSync(full); }
        else writeAtomic(full, edit.before);
        this.edits.delete(path);
      } catch { conflicts.push(path); }
    }
    return conflicts;
  }
}
