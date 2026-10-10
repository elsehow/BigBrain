/** projectionWake.ts — how the viewer learns that a commit landed
 * (docs/plans/2026-10-10-change-log.md, step 4). Every engine write commits
 * to the projection, whichever process makes it, so the projection is the one
 * place to listen. `PRAGMA data_version` on one held read connection is the
 * truth: it moves whenever another connection commits. A change to the WAL
 * file is the wake-up that asks it, and a slow check covers a wake-up missed.
 *
 * A projection that appears, or is replaced under the held connection (a
 * deleted `.state/`), counts as a move: the connection is opened again. */
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { assertionDbPath, openAssertionProjectionReadonly } from "./assertionProjection";

export interface ProjectionWake {
  /** Whether a commit landed since the last call. The first call only looks. */
  moved(): boolean;
  close(): void;
}

const dataVersion = (db: Database): number =>
  (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;

export function projectionWake(root: string): ProjectionWake {
  const path = assertionDbPath(root);
  let db: Database | undefined, inode = 0, version = 0, looked = false;
  const close = () => { db?.close(); db = undefined; inode = 0; };
  return {
    moved(): boolean {
      const first = !looked;
      looked = true;
      let at: number;
      try { at = statSync(path).ino; } catch { close(); return false; } // no projection yet
      if (!db || at !== inode) {
        close();
        try { db = openAssertionProjectionReadonly(root); } catch { return false; }
        inode = at; version = dataVersion(db);
        return !first;
      }
      const next = dataVersion(db);
      if (next === version) return false;
      version = next;
      return true;
    },
    close,
  };
}
