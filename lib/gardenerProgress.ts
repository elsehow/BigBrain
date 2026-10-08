import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { intakeHolder, intakeRunning } from "./assertionAgent";
import { writeAtomic } from "./fsx";
import type { GardenerProgress } from "./gardenerProgressTypes";
import type { ToolActivity } from "./run/toolActivity";
import type { SubmitResult } from "./work";

/** In a directory of its own, so the viewer's watcher knows its atomic
 * writes' temporary files (lib/liveEvents.ts). */
export const GARDENER_PROGRESS_DIR = join(".state", "gardener");
export const GARDENER_PROGRESS_PATH = join(GARDENER_PROGRESS_DIR, "progress.json");
/** A status belongs to the live lock holder, not a previous/crashed run. */
export function readGardenerProgress(root: string): GardenerProgress | null {
  try {
    if (!intakeRunning(root)) return null;
    const row = JSON.parse(readFileSync(join(root, GARDENER_PROGRESS_PATH), "utf8"));
    if (row.pid !== intakeHolder(root)) return null;
    const { phase, waitingForModel, batch, claims, rejected, batches, lookups, startedAt, updatedAt, firstFilingMs } = row;
    if (!["starting", "reviewing", "reading", "context", "saving", "checking", "finishing", "retrying"].includes(phase)
      || typeof waitingForModel !== "boolean" || ![batch, claims, rejected, batches, lookups].every(n => Number.isSafeInteger(n) && n >= 0)
      || typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))
      || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))
      || (firstFilingMs !== null && (!Number.isFinite(firstFilingMs) || firstFilingMs < 0))) return null;
    return { phase, waitingForModel, batch, claims, rejected, batches, lookups, startedAt, updatedAt, firstFilingMs };
  } catch { return null; }
}

export function startGardenerProgress(root: string, now = () => Date.now()) {
  const started = now();
  const status: GardenerProgress = { phase: "starting", waitingForModel: true, batch: 0, claims: 0,
    rejected: 0, batches: 0, lookups: 0, startedAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(), firstFilingMs: null };
  let active = 0;
  const publish = () => {
    status.updatedAt = new Date(now()).toISOString();
    try { writeAtomic(join(root, GARDENER_PROGRESS_PATH), JSON.stringify({ ...status, pid: process.pid }), 0o600); } catch { /* best-effort local status */ }
  };
  publish();
  return {
    observe(event: ToolActivity): void {
      if (event.phase === "start") {
        active++;
        status.phase = event.name === "submit" ? "saving" : event.name === "next" ? "checking" : event.name === "search_vault" ? "context" : "reading";
      } else {
        active = Math.max(0, active - 1);
        if (event.phase === "error") status.phase = "retrying";
        else if (event.name === "next" && Array.isArray(event.result)) {
          status.batch = event.result.filter(item => item.job?.kind === "intake" || item.job?.kind === "staged").length;
          if (status.batch) status.batches++;
          status.phase = status.batch ? "reviewing" : "finishing";
        } else if (event.name === "submit") {
          const result = event.result as SubmitResult;
          const items = Array.isArray(event.args.items) ? event.args.items : [];
          const filed = result.results.filter(row => row.ok && !row.deduped && items[row.index]?.submit === "assertion").length;
          status.claims += filed;
          status.rejected += result.rejected;
          if (filed && status.firstFilingMs === null) status.firstFilingMs = now() - started;
          status.phase = result.rejected ? "retrying" : "reviewing";
        } else { status.lookups++; status.phase = "reviewing"; }
      }
      status.waitingForModel = active === 0;
      publish();
    },
    finish(): void { try { rmSync(join(root, GARDENER_PROGRESS_PATH), { force: true }); } catch { /* the reader checks the lock's holder */ } },
  };
}
