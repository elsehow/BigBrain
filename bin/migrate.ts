/**
 * migrate.ts — convert the retired logs to assertions (lib/migrate.ts):
 * declines, revocations, aliases, bindings, copy judgments and fold rejects
 * become assertions in log/assertions/, and the logs nothing reads go. The
 * owner's say-so is `--yes` (docs/design-principles.md §5). The run checks
 * that the new record reads as the old logs did, and puts the vault back if
 * it does not.
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
if (!hasFlag(process.argv.slice(2), "yes")) {
  console.log("\nNothing written. `bigbrain migrate --yes` converts, checks the new record reads as the old logs did, and commits.");
  process.exit(0);
}
const { written, committed } = migrateVault(VAULT_ROOT, plan);
console.log(`\nmigrate: ${written} assertions written; the new record reads as the old logs did${committed ? "; committed" : ""}`);
