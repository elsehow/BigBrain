/**
 * migrate.ts — convert the retired logs to assertions and the retired trees
 * to sources (lib/migrate.ts): declines, revocations, aliases, bindings, copy
 * judgments and fold rejects become assertions in log/assertions/, what
 * arrived in references/, inbox/ and requests/ that no source holds becomes
 * one, and the logs nothing reads and the four trees go. The owner's say-so
 * is `--yes` (docs/design-principles.md §5). The run checks that the new
 * record reads as the old logs did and that a source holds every file it
 * removes, and puts the vault back if not.
 *
 * Usage: bigbrain migrate          what would change; nothing is written
 *        bigbrain migrate --yes    convert, check, commit
 */

import { hasFlag } from "../lib/cliflags";
import { migrateVault, needsMigration, planMigration } from "../lib/migrate";
import { VAULT_ROOT } from "../lib/vaultRoot";

if (!needsMigration(VAULT_ROOT)) {
  console.log("migrate: nothing to migrate");
  process.exit(0);
}
const plan = planMigration(VAULT_ROOT);
for (const [log, { events, assertions }] of Object.entries(plan.counts))
  if (events) console.log(`${log}: ${events} events → ${assertions} assertions`);
for (const [log, files] of Object.entries(plan.unread)) console.log(`${log}: ${files} files, read by nothing → deleted`);
if (plan.unsaid.length) console.log(`${plan.unsaid.length} withdrew nothing standing (a self-alias or an unbind of nothing) and become nothing`);
for (const [tree, t] of Object.entries(plan.trees.trees)) {
  if (tree === "entities") { console.log(`entities: ${t.files} dossiers of the retired editor → deleted`); continue; }
  const parts = [
    t.held && `${t.held} already sources`, t.repeats && `${t.repeats} repeat a source's content`, t.imported && `${t.imported} imported as sources`,
  ].filter(Boolean);
  console.log(`${tree}: ${t.files} files${parts.length ? `; ${parts.join(", ")}` : ""} → deleted`);
}
if (!hasFlag(process.argv.slice(2), "yes")) {
  console.log("\nNothing written. `bigbrain migrate --yes` converts, checks the new record reads as the old logs did and holds every removed file, and commits.");
  process.exit(0);
}
const { written, imported, committed, kept } = migrateVault(VAULT_ROOT, plan);
console.log(`\nmigrate: ${written} assertions and ${imported} sources written; the new record reads as the old logs did and holds every removed file${committed ? "; committed" : ""}`);
if (kept) console.log(`${kept.files} removed files git never tracked are kept in ${kept.path}; delete it when you no longer want them`);
