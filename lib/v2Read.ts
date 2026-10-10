/**
 * v2Read.ts — the v2 view's one read of the projection (engine side;
 * lib/v2Feed.ts stays pure so the viewer can share it). The route reads
 * it inside withVaultSnapshot; the dev preview reads a vault's projection
 * opened read-only (bin/v2Preview.ts). Given the vault root, it also reads
 * the gardener's run journals, which name the model its rows don't.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { AssertionEvent } from "./assertionLog";
import { entityAliasResolution, type EntityAliasEvent } from "./entityAliasLog";
import { liveAssertionSql } from "./sourceSupersede";
import { tendJournalFiles } from "./tend";
import { firstRecordedAt, type ChainLink, type V2Source } from "./v2Feed";

export function readV2Source(db: Database, root?: string): V2Source {
  const events = <T>(sql: string): T[] => (db.query(sql).all() as { event_json: string }[]).map((r) => JSON.parse(r.event_json) as T);
  const rows = events<AssertionEvent>(`SELECT a.event_json FROM assertions a WHERE a.revoked_by IS NULL AND ${liveAssertionSql("a")} ORDER BY a.created_at, a.id`);
  const aliases = entityAliasResolution(events<EntityAliasEvent>("SELECT event_json FROM entity_alias_events"));
  const chain = db.query("SELECT id, created_at, json_extract(event_json, '$.supersedes') AS supersedes FROM assertions").all() as ChainLink[];
  return { rows, aliases, firstAt: firstRecordedAt(rows, new Map(chain.map((c) => [c.id, c]))), ...(root ? { models: gardenerModels(root, rows) } : {}) };
}

/** The client names the gardener writes under (lib/run/sessionJob.ts, bin/gardenerMcp.ts). */
const GARDENER_CLIENTS = new Set(["pi", "claude"]);
interface TendRun { start: string; end: string; model: string }
/** Each journal read once: a run's journal is written whole when it ends and never again. */
const journals = new Map<string, TendRun | null>();
function tendRuns(root: string): TendRun[] {
  const out: TendRun[] = [];
  for (const { path } of tendJournalFiles(root)) {
    let run = journals.get(path);
    if (run === undefined) {
      try {
        const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        run = typeof j["model"] === "string" && j["model"] && typeof j["started_at"] === "string" && typeof j["completed_at"] === "string"
          ? { start: j["started_at"], end: j["completed_at"], model: j["model"] } : null;
      } catch { run = null; }
      journals.set(path, run);
    }
    if (run) out.push(run);
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** The model behind each row the gardener wrote through its agent. The
 * record names only the agent (lib/vaultTools.ts: run attribution is the
 * journal's job); the journal of the run it was written during names the
 * model. The tend lock keeps runs from overlapping, so that run is one. */
export function gardenerModels(root: string, rows: readonly AssertionEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  const theirs = rows.filter((r) => r.author.kind === "model" && GARDENER_CLIENTS.has(r.author.id) && r.produced_by.procedure === "bigbrain-mcp");
  if (!theirs.length) return out;
  const runs = tendRuns(root);
  for (const row of theirs) {
    // the last run started at or before it
    let lo = 0, hi = runs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (runs[mid]!.start <= row.created_at) lo = mid + 1; else hi = mid; }
    const run = runs[lo - 1];
    if (run && row.created_at <= run.end) out.set(row.id, run.model);
  }
  return out;
}
