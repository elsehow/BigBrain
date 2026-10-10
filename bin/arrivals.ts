/**
 * arrivals.ts — the arrivals worker's round (lib/door.ts): settle every
 * arrival still waiting for the firewall, oldest first. Whoever queues an
 * arrival settles it at once; this retries the ones the firewall could not
 * answer for, on the supervisor's schedule (lib/desktopSchedule.ts).
 *
 * Usage: bun bin/arrivals.ts
 */

import { sweep } from "../lib/door";
import { VAULT_ROOT } from "../lib/vaultRoot";

const { settled, waiting } = await sweep(VAULT_ROOT);
if (settled || waiting) console.log(`arrivals: ${settled} settled${waiting ? `, ${waiting} waiting for the firewall` : ""}`);
