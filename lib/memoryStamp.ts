/** memoryStamp.ts — where the memory pass stands, and the check every
 * reader of one applies (lib/memory.ts). Its POSITION — the checkpoint, the
 * cursors, the protocol and the run that folded last — is the record's: the
 * latest run journal that carries one (journal/memory/), projected
 * (lib/views/memory.ts). Its SCHEDULE — when it is next due, and the commit
 * it made last — is this computer's, kept in .state and recoverable from
 * the same journal. Pure: a view reads it. */
import type { LogCursor, MemoryCheckpoint } from "./memoryInputs";

export interface MemoryStamp {
  protocolVersion?: number;
  /** Exact input census from the last successful run. */
  checkpoint?: MemoryCheckpoint;
  lastRunAt?: string;
  nextRunAt?: string;
  lastCommit?: string;
  run?: string;
  /** newest source-insertion event folded in (native vaults; reader order
   * is `received_at ?? occurred_at`, id tiebreak). */
  insertionCursor?: LogCursor;
  /** newest assertion event folded in (native vaults; reader order is
   * `created_at`, id tiebreak). */
  assertionCursor?: LogCursor;
}

/** A malformed cache must not break the work view or hide a valid journal. */
export function isMemoryStamp(value: unknown): value is MemoryStamp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.protocolVersion !== undefined &&
      (!Number.isSafeInteger(row.protocolVersion) || (row.protocolVersion as number) < 0)) return false;
  for (const key of ["lastRunAt", "nextRunAt", "lastCommit", "run"])
    if (row[key] !== undefined && typeof row[key] !== "string") return false;
  for (const key of ["assertionCursor", "insertionCursor"]) {
    const cursor = row[key] as LogCursor | undefined;
    if (cursor !== undefined && (!cursor || typeof cursor.at !== "string" || typeof cursor.id !== "string")) return false;
  }
  if (row.checkpoint !== undefined) {
    if (!row.checkpoint || typeof row.checkpoint !== "object") return false;
    const checkpoint = row.checkpoint as Record<string, unknown>;
    for (const key of ["assertions", "insertions", "revocations", "aliases"]) {
      const ids = checkpoint[key];
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return false;
    }
    const shared = checkpoint["shared"];
    if (shared !== undefined) {
      if (!shared || typeof shared !== "object" || Array.isArray(shared)) return false;
      for (const vault of Object.values(shared as Record<string, unknown>)) {
        const v = vault as { head?: unknown; assertions?: unknown } | null;
        if (!v || !Number.isSafeInteger(v.head) || !Array.isArray(v.assertions) || !v.assertions.every((id) => typeof id === "string")) return false;
      }
    }
  }
  return true;
}
