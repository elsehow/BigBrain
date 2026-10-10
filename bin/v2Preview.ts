/**
 * v2Preview.ts — /api/v2 for a vault, read without touching it.
 *
 * The dev preview (web/ui/devV2Live.ts) runs this against a REAL vault
 * while every other /api request goes to the engine already tending it. So
 * it opens the projection read-only and never syncs it: a second engine on
 * one vault would sync the projection and tick shared publishing beside the
 * first (web/server.ts start()). Whatever the live engine has projected is
 * what this reads.
 *
 *   bun bin/v2Preview.ts <vault>             → the /api/v2 JSON
 *   bun bin/v2Preview.ts <vault> <entity-id> → /api/v2/entity's JSON
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildEntityFeed, buildV2Feed } from "../lib/v2Feed";
import { readV2Source } from "../lib/v2Read";

const [vault, entity] = process.argv.slice(2);
if (!vault) {
  console.error("usage: bun bin/v2Preview.ts <vault> [entity-id]");
  process.exit(2);
}
const db = new Database(join(vault, ".state", "assertions.db"), { readonly: true });
try {
  const src = readV2Source(db, vault);
  process.stdout.write(JSON.stringify(entity ? { rows: buildEntityFeed(src, entity) } : buildV2Feed(src)));
} finally {
  db.close();
}
