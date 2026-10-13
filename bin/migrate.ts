/**
 * migrate.ts — convert the retired logs to assertions and the retired trees
 * to sources (lib/migrate.ts): declines, revocations, aliases, bindings, copy
 * judgments and fold rejects become assertions in log/assertions/, what
 * arrived in references/, inbox/ and requests/ that no source holds becomes
 * one, and the logs nothing reads and the four trees go. The owner's say-so
 * is `--yes` (docs/design-principles.md §5). The run checks that the new
 * record reads as the old logs did and that a source holds every file it
 * removes, and puts the vault back if not. Lenses kept beside this
 * computer's settings move into the vault (lib/lensMigrate.ts).
 *
 * Usage: bigbrain migrate          what would change; nothing is written
 *        bigbrain migrate --yes    convert, check, commit
 */

import { hasFlag } from "../lib/cliflags";
import { legacyLenses, migrateLenses, planLensMigration } from "../lib/lensMigrate";
import { migrateVault, needsMigration, planMigration } from "../lib/migrate";
import { connectionStorePath } from "../lib/sharedConnections";
import { VAULT_ROOT } from "../lib/vaultRoot";

const store = connectionStorePath();
const logs = needsMigration(VAULT_ROOT), lenses = legacyLenses(VAULT_ROOT, store).length > 0;
if (!logs && !lenses) {
  console.log("migrate: nothing to migrate");
  process.exit(0);
}
// The logs first: a lens's verdicts cite sources the trees may still have to give.
if (logs) migrateLogs();
if (lenses) migrateLensesIn();

function migrateLogs(): void {
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
    return;
  }
  const { written, imported, committed, kept } = migrateVault(VAULT_ROOT, plan);
  console.log(`\nmigrate: ${written} assertions and ${imported} sources written; the new record reads as the old logs did and holds every removed file${committed ? "; committed" : ""}`);
  if (kept) console.log(`${kept.files} removed files git never tracked are kept in ${kept.path}; delete it when you no longer want them`);
}

function migrateLensesIn(): void {
  const plans = planLensMigration(VAULT_ROOT, store);
  console.log(`\nlenses: ${plans.length} kept on this computer → the vault's lenses/, their verdicts as inclusion assertions`);
  for (const p of plans) {
    console.log(`  ${p.lens.name}: ${p.ratings} rating(s), ${p.pins} pin(s), ${p.exclusions} exclusion(s), ${p.scored} score(s) already paid for` +
      `; of ${p.kept + p.pending + p.out.length} member(s), ${p.kept} stay, ${p.pending} wait to be scored again` +
      (p.out.length ? `, ${p.out.length} would leave` : "") + (p.dropped ? `; ${p.dropped} edit(s) name notes the vault no longer holds` : ""));
    if (p.out.length && p.lens.servers.length) console.log(`    ${p.out.length} would be withdrawn from the servers this lens is shared with`);
  }
  if (!hasFlag(process.argv.slice(2), "yes")) {
    console.log("\nNothing written. `bigbrain migrate --yes` moves them in and commits; until then their servers are left as they are.");
    return;
  }
  const { lenses: moved, assertions, committed } = migrateLenses(VAULT_ROOT, store, plans);
  console.log(`\nmigrate: ${moved} lens(es) moved in, ${assertions} inclusion assertion(s) written${committed ? "; committed" : ""}; the old files are in .state/lens-migration/`);
}
