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
 *   bun bin/squadPreview.ts <vault>             → the /api/squad JSON
 *   bun bin/squadPreview.ts <vault> <entity-id> → /api/squad/entity's JSON
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildEntityFeed, buildSquad } from "../lib/squadGraph";
import { readSquadSource } from "../lib/squadRead";

const [vault, entity] = process.argv.slice(2);
if (!vault) {
  console.error("usage: bun bin/squadPreview.ts <vault> [entity-id]");
  process.exit(2);
}
const db = new Database(join(vault, ".state", "assertions.db"), { readonly: true });
try {
  const src = readSquadSource(db);
  process.stdout.write(JSON.stringify(entity ? { rows: buildEntityFeed(src, entity) } : buildSquad(src)));
} finally {
  db.close();
}
