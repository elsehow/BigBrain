/** Memory scheduling and locking. Successful runs checkpoint the events
 * they observed in journal/memory; .state/memory.json caches that position.
 * Voice is evidence for curation and is rendered as data. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hasAssertionEvents, type AssertionEvent } from "./assertionLog";
import { ensureDir, writeAtomic } from "./fsx";
import { scheduledVerdict, type StageVerdict } from "./chain";
import { acquire, held, release } from "./pidLock";
import type { SourceInsertion } from "./insertionLog";
import { loadManifest } from "./manifest";
import { memoryInputDelta, readMemoryInputs, type MemoryCheckpoint, type LogCursor } from "./memoryInputs";
import { readSharedMemory, sharedMemoryDelta } from "./sharedMemory";
export { pastCursor, type LogCursor } from "./memoryInputs";

/** The memory pass's BIGBRAIN_ROLE value — the ONE machine role allowed to
 * see and write `memory/`. Lives here (not bin/memory.ts) so importing it
 * never executes the runner. */
export const MEMORY_ROLE = "memory";

/** Bump only when existing memory must be selected again from the record.
 * Routine prompt edits do not require a rebuild. Unversioned trees are v0. */
export const MEMORY_PROTOCOL_VERSION = 1;

// ── the pass's state stamp ──────────────────────────────────────────────────

const memoryStampFile = (root: string): string => join(root, ".state", "memory.json");

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

/** The two log readers' sort keys, named so the cursor comparisons and the
 * cursor advances cannot drift from the order the readers actually use. */
export const assertionAt = (e: AssertionEvent): string => e.created_at;
export const insertionAt = (e: Pick<SourceInsertion, "received_at" | "occurred_at">): string => e.received_at ?? e.occurred_at ?? "";

/** Unseen assertions, using the same input checkpoint as the runner. */
export function assertionDelta(root: string, stamp: MemoryStamp): AssertionEvent[] {
  return memoryInputDelta(readMemoryInputs(root), stamp).astDelta;
}

export function voiceDelta(root: string, stamp: MemoryStamp): SourceInsertion[] {
  return memoryInputDelta(readMemoryInputs(root), stamp).voiceNotes;
}

/** A malformed cache must not break the work view or hide a valid journal. */
function isMemoryStamp(value: unknown): value is MemoryStamp {
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

/** .state is a cache. The run journal retains the same checkpoint and
 * schedule, including failed attempts' backoff, for recovery after deletion. */
export function readMemoryStamp(root: string): MemoryStamp {
  try {
    const stamp = JSON.parse(readFileSync(memoryStampFile(root), "utf8"));
    if (isMemoryStamp(stamp)) return stamp;
  } catch { /* recover from the journal */ }
  const dir = join(root, "journal", "memory");
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse(); }
  catch { return {}; }
  let latestAttempt: number | undefined;
  for (const file of files) {
    try {
      const row = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (isMemoryStamp(row.memoryStamp)) return row.memoryStamp;
      // Older journals have no checkpoint. A successful run establishes
      // that memory was enabled; reconcile it once on the normal schedule.
      const started = Date.parse(row.startedAt);
      if (!Number.isFinite(started)) continue;
      latestAttempt ??= started + (typeof row.wallMs === "number" ? row.wallMs : 0);
      if (row.error) continue;
      return {
        run: typeof row.run === "string" ? row.run : file.slice(0, -5),
        lastRunAt: row.startedAt,
        nextRunAt: new Date((latestAttempt ?? started) + loadManifest(root).memory.intervalMs).toISOString(),
      };
    } catch { /* an unreadable journal is not a recovery checkpoint */ }
  }
  return {};
}

export function writeMemoryStamp(root: string, stamp: MemoryStamp): void {
  ensureDir(join(root, ".state"));
  writeAtomic(memoryStampFile(root), JSON.stringify(stamp) + "\n");
}

// ── what the pass is waiting on ─────────────────────────────────────────────
// ONE definition of "memory has something to do", used by the runner's
// due-check AND by the queue view. They must never disagree: a screen
// promising a sweep the gate will refuse to run is worse than no screen.

/** Unseen voice, assertions, and changes that invalidate the current
 * record. Raw insertions alone wait for extraction to produce assertions. */
export interface MemoryWork {
  voice: SourceInsertion[];
  record: number;
  /** New assertions in joined shared vaults (lib/sharedMemory.ts). */
  shared?: number;
  recordChanged?: boolean;
}

/** Only existing native memory needs migration; empty vaults retain explicit bootstrap. */
export function memoryNeedsRebuild(root: string, stamp: MemoryStamp = readMemoryStamp(root)): boolean {
  return (stamp.protocolVersion ?? 0) < MEMORY_PROTOCOL_VERSION &&
    existsSync(join(root, "memory", "MEMORY.md")) && hasAssertionEvents(root);
}

export function memoryWork(root: string, stamp: MemoryStamp = readMemoryStamp(root)): MemoryWork {
  const delta = memoryInputDelta(readMemoryInputs(root), stamp);
  const shared = sharedMemoryDelta(readSharedMemory(root), stamp.checkpoint?.shared);
  return { voice: delta.voiceNotes, record: delta.astDelta.length,
    ...(shared.fresh.length ? { shared: shared.fresh.length } : {}),
    ...(delta.recordChanged || shared.recordChanged ? { recordChanged: true } : {}) };
}

export const hasMemoryWork = (w: MemoryWork): boolean => w.voice.length > 0 || w.record > 0 || Boolean(w.shared) || Boolean(w.recordChanged);

/** "2 voice note(s) + 3 new assertion(s)" — the reason strings' shared half. */
export function describeMemoryWork(w: MemoryWork): string {
  return [
    ...(w.voice.length ? [`${w.voice.length} voice note(s)`] : []),
    ...(w.record ? [`${w.record} new assertion(s)`] : []),
    ...(w.shared ? [`${w.shared} new shared-vault assertion(s)`] : []),
    ...(w.recordChanged ? ["record corrections or identity changes"] : []),
  ].join(" + ");
}

/** Memory is the classic chain's scheduled stage, judged by the one rule
 * (lib/chain.ts scheduledVerdict): work and an elapsed schedule are both
 * required, unless forced. Each attempt, including failure, schedules the
 * next full interval, so ticks cannot repeatedly bill retries. */
export function memoryDue(
  root: string,
  opts: { force?: boolean; now?: Date } = {}
): StageVerdict {
  const stamp = readMemoryStamp(root);
  return scheduledVerdict({
    ...opts, nextRunAt: stamp.nextRunAt,
    work: () => {
      const w = memoryWork(root, stamp);
      return hasMemoryWork(w) ? describeMemoryWork(w) : undefined;
    },
    idle: "nothing to fold in — no voice, no new assertions",
  });
}

// ── the memory pass's own lock ──────────────────────────────────────────────
// Not the editor's: the two passes write disjoint trees and may overlap;
// commits use commitPathsOnly so neither sweeps the other's staged work.

export const memoryLockDir = (root: string): string => join(root, ".state", "memory.lock");

export function acquireMemoryLock(root: string): boolean {
  ensureDir(join(root, ".state"));
  return acquire(memoryLockDir(root), "memory");
}

export function releaseMemoryLock(root: string): void {
  release(memoryLockDir(root));
}

/** Is a sweep executing right now? A pure read of the lock — dir held AND
 * its pid alive (a crashed run's stale lock must not read as running; the
 * next acquire reclaims it anyway). The queue view's activity spinner
 * hangs off this: gray dot = waiting, spinner = executing (Nick,
 * 2026-08-05 — the bullet reports activity, never pass identity). */
export function memoryRunning(root: string): boolean {
  return held(memoryLockDir(root));
}
