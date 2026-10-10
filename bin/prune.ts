/**
 * prune.ts — removes agent scratch nothing will read again (#217): archived
 * sessions' scratch (lib/scratchPrune.ts) and the retired workers'
 * (lib/legacy.ts). On the supervisor's schedule, and at launch.
 *
 * Usage: bun bin/prune.ts
 */

import { retireWorkerWorkspaces } from "../lib/legacy";
import { pruneSessionScratch } from "../lib/scratchPrune";
import { VAULT_ROOT } from "../lib/vaultRoot";

const retired = retireWorkerWorkspaces(VAULT_ROOT);
const { removed } = pruneSessionScratch(VAULT_ROOT);
if (retired === "removed") console.log("prune: removed the retired workers' scratch");
if (removed.length) console.log(`prune: removed scratch of ${removed.length} archived session${removed.length === 1 ? "" : "s"}`);
