/**
 * squadRead.ts — the squad view's one read of the projection (engine side;
 * lib/squadGraph.ts stays pure so the viewer can share it). The route reads
 * it inside withVaultSnapshot; the dev preview reads a vault's projection
 * opened read-only (bin/squadPreview.ts).
 */
import type { Database } from "bun:sqlite";
import type { AssertionEvent } from "./assertionLog";
import { entityAliasResolution, type EntityAliasEvent } from "./entityAliasLog";
import { liveAssertionSql } from "./sourceSupersede";
import { firstRecordedAt, type ChainLink, type SquadSource } from "./squadGraph";

export function readSquadSource(db: Database): SquadSource {
  const events = <T>(sql: string): T[] => (db.query(sql).all() as { event_json: string }[]).map((r) => JSON.parse(r.event_json) as T);
  const rows = events<AssertionEvent>(`SELECT a.event_json FROM assertions a WHERE a.revoked_by IS NULL AND ${liveAssertionSql("a")} ORDER BY a.created_at, a.id`);
  const aliases = entityAliasResolution(events<EntityAliasEvent>("SELECT event_json FROM entity_alias_events"));
  const chain = db.query("SELECT id, created_at, json_extract(event_json, '$.supersedes') AS supersedes FROM assertions").all() as ChainLink[];
  return { rows, aliases, firstAt: firstRecordedAt(rows, new Map(chain.map((c) => [c.id, c]))) };
}
