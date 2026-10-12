/**
 * recover.ts — project what was changed in log/ by hand: a file copied in, a
 * source retracted by deleting its file or restored, an event left behind by
 * a process that died between its append and its projection. Every engine
 * process runs this census once when it starts; this runs it now. A running
 * viewer hears the commit and pushes it to open tabs (lib/liveEvents.ts).
 *
 * Usage: bigbrain recover
 */

import { projectionChangesSince, projectionRevision, recoverAssertionProjection } from "../lib/assertionProjection";
import { VAULT_ROOT } from "../lib/vaultRoot";

const before = projectionRevision(VAULT_ROOT);
recoverAssertionProjection(VAULT_ROOT);
const log = before ? projectionChangesSince(VAULT_ROOT, before) : undefined;
if (!log) console.log("recover: the projection was rebuilt from the log");
else if (!log.changes.length) console.log("recover: the projection already matches the log");
else {
  const count = (op: string) => log.changes.filter((c) => c.op === op).length;
  const [added, removed, edited] = [count("add"), count("remove"), count("edit")];
  console.log(`recover: ${[added && `${added} added`, removed && `${removed} removed`, edited && `${edited} edited`].filter(Boolean).join(", ")}`);
}
