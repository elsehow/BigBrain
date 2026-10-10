/**
 * copies.ts — the copies judging pass (lib/sourceCopyJudge.ts): candidates
 * that might be one document, scored by Jev or Quick, on the supervisor's
 * schedule (lib/desktopSchedule.ts).
 *
 * Usage: bun bin/copies.ts
 */

import { judgeCopies } from "../lib/sourceCopyJudge";
import { connectionStorePath } from "../lib/sharedConnections";
import { VAULT_ROOT } from "../lib/vaultRoot";

const { judged, failed, left } = await judgeCopies(VAULT_ROOT, connectionStorePath());
if (judged || failed) console.log(`copies: ${judged} judged${failed ? `, ${failed} failed` : ""}${left > judged ? `, ${left - judged} left` : ""}`);
