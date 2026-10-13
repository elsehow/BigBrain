/** Memory scheduling and locking. Each run records the events it observed
 * in its journal (journal/memory/), and the latest such record is where the
 * pass stands (lib/memoryStamp.ts); .state/memory.json keeps only when it
 * is next due. Voice is evidence for curation and is rendered as data. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasAssertionEvents, type AssertionEvent } from "./assertionLog";
import { ensureDir, writeAtomic } from "./fsx";
import { scheduledVerdict, type StageVerdict } from "./chain";
import type { SourceInsertion } from "./insertionLog";
import { loadManifest } from "./manifest";
import { memoryInputDelta, readMemoryInputs } from "./memoryInputs";
import type { MemoryStamp } from "./memoryStamp";
import { withSnapshot } from "./vaultReadModel";
import { memoryPositionOf, type MemoryPosition } from "./views/memory";
import { readSharedMemory, sharedMemoryDelta } from "./sharedMemory";
import { isHeld, tryHold, type Hold } from "./sqliteLock";
export { pastCursor, type LogCursor } from "./memoryInputs";
export type { MemoryStamp } from "./memoryStamp";

/** The memory pass's BIGBRAIN_ROLE value — the ONE machine role allowed to
 * see and write `memory/`. Lives here (not bin/memory.ts) so importing it
 * never executes the runner. */
export const MEMORY_ROLE = "memory";

/** Bump only when existing memory must be selected again from the record.
 * Routine prompt edits do not require a rebuild. Unversioned trees are v0.
 * A tree behind it is rebuilt from scratch by its next run (lib/stages/memory.ts).
 * v2: memory is one file, memory/MEMORY.md — v1 trees were an index and
 * topic files. */
export const MEMORY_PROTOCOL_VERSION = 2;

// ── the pass's state stamp ──────────────────────────────────────────────────

const memoryStampFile = (root: string): string => join(root, ".state", "memory.json");


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


/** Where the pass stands. Its position is the record's: the latest run
 * journal's (lib/views/memory.ts), read from a snapshot, so the due check
 * and the queue view read the one the run that wrote it left. Its schedule
 * is this computer's (.state/memory.json), and the same journal recovers it
 * when .state is gone: each attempt, failed ones included, records when the
 * next is due. */
export function readMemoryStamp(root: string): MemoryStamp {
  let position: MemoryPosition | undefined;
  try { position = withSnapshot(root, memoryPositionOf); } catch { /* no projection yet: nothing recorded */ }
  const recorded: MemoryStamp = !position ? {} : "stamp" in position ? position.stamp : {
    // Older journals have no checkpoint. A successful run establishes that
    // memory was enabled; reconcile it once on the normal schedule.
    run: position.legacy.run, lastRunAt: position.legacy.lastRunAt,
    nextRunAt: new Date(position.legacy.attemptEnded + loadManifest(root).memory.intervalMs).toISOString(),
  };
  return { ...recorded, ...readSchedule(root) };
}

/** What this computer keeps of the stamp: when the pass is next due, and
 * the commit it made last. */
export type MemorySchedule = Pick<MemoryStamp, "nextRunAt" | "lastCommit">;

function readSchedule(root: string): MemorySchedule {
  try {
    const held = JSON.parse(readFileSync(memoryStampFile(root), "utf8")) as Record<string, unknown>;
    return {
      ...(typeof held.nextRunAt === "string" ? { nextRunAt: held.nextRunAt } : {}),
      ...(typeof held.lastCommit === "string" ? { lastCommit: held.lastCommit } : {}),
    };
  } catch { return {}; }
}

/** Keep the schedule. The position is never written here: a run's journal
 * records it (lib/stages/memory.ts). */
export function writeMemorySchedule(root: string, schedule: MemorySchedule): void {
  ensureDir(join(root, ".state"));
  const { nextRunAt, lastCommit } = schedule;
  writeAtomic(memoryStampFile(root), JSON.stringify({ ...(nextRunAt ? { nextRunAt } : {}), ...(lastCommit ? { lastCommit } : {}) }) + "\n");
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

export const memoryLockFile = (root: string): string => join(root, ".state", "memory.lock.sqlite");

/** The pass's hold, or null when another run has it (lib/sqliteLock.ts:
 * freed the moment its holder dies, so nothing is ever stale). */
export function acquireMemoryLock(root: string): Hold | null {
  ensureDir(join(root, ".state"));
  return tryHold(memoryLockFile(root), { name: "memory", retired: join(root, ".state", "memory.lock") });
}

/** Is a sweep executing right now? Asks the lock itself, so a crashed run
 * never reads as running. The queue view's activity spinner
 * hangs off this: gray dot = waiting, spinner = executing (Nick,
 * 2026-08-05 — the bullet reports activity, never pass identity). */
export function memoryRunning(root: string): boolean {
  return isHeld(memoryLockFile(root));
}
