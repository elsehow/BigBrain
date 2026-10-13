/** memory.ts — where the memory pass stands, as the record says
 * (lib/memoryStamp.ts): the latest run journal that carries a position
 * (journal/memory/, projected as memory_runs). A run from before journals
 * carried one says only when it ran: the latest that succeeded, and when the
 * latest attempt ended, from which its schedule follows (lib/memory.ts).
 */
import { isMemoryStamp, type MemoryStamp } from "../memoryStamp";
import type { Snapshot } from "./view";

export type MemoryPosition =
  | { stamp: MemoryStamp }
  | { legacy: { run: string; lastRunAt: string; attemptEnded: number } };

export function memoryPositionOf({ db }: Snapshot): MemoryPosition | undefined {
  const rows = db.query("SELECT rel, stamp_json, run, started_at, wall_ms, failed FROM memory_runs ORDER BY rel DESC").all() as
    { rel: string; stamp_json: string | null; run: string | null; started_at: string | null; wall_ms: number | null; failed: number }[];
  let attemptEnded: number | undefined;
  for (const row of rows) {
    if (row.stamp_json) {
      try {
        const stamp = JSON.parse(row.stamp_json) as unknown;
        if (isMemoryStamp(stamp)) return { stamp };
      } catch { /* an unreadable record is not a position */ }
    }
    // older journals have no position: a run that succeeded says memory was on
    const started = Date.parse(row.started_at ?? "");
    if (!Number.isFinite(started)) continue;
    attemptEnded ??= started + (row.wall_ms ?? 0);
    if (row.failed) continue;
    return { legacy: { run: row.run ?? row.rel.slice(row.rel.lastIndexOf("/") + 1, -".json".length), lastRunAt: row.started_at!, attemptEnded } };
  }
  return undefined;
}
