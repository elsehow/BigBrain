/**
 * squadPreview.ts — /api/squad for a vault, read without touching it.
 *
 * The dev preview (web/ui/devSquadLive.ts) runs this against a REAL vault
 * while every other /api request goes to the engine already tending it. So
 * it opens the projection read-only and never syncs it: a second engine on
 * one vault would sync the projection and tick shared publishing beside the
 * first (web/server.ts start()). Whatever the live engine has projected is
 * what this reads.
 *
 *   bun bin/squadPreview.ts <vault>   → the /api/squad JSON on stdout
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AssertionEvent } from "../lib/assertionLog";
import { entityAliasResolution, type EntityAliasEvent } from "../lib/entityAliasLog";
import { buildSquad } from "../lib/squadGraph";

const vault = process.argv[2];
if (!vault) {
  console.error("usage: bun bin/squadPreview.ts <vault>");
  process.exit(2);
}
const db = new Database(join(vault, ".state", "assertions.db"), { readonly: true });
const events = <T>(sql: string): T[] => (db.query(sql).all() as { event_json: string }[]).map((r) => JSON.parse(r.event_json) as T);
try {
  const rows = events<AssertionEvent>("SELECT event_json FROM assertions WHERE revoked_by IS NULL ORDER BY created_at, id");
  const aliases = entityAliasResolution(events<EntityAliasEvent>("SELECT event_json FROM entity_alias_events"));
  process.stdout.write(JSON.stringify(buildSquad(rows, aliases)));
} finally {
  db.close();
}
