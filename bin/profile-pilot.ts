/** Read-only Pilot timing report. bun bin/profile-pilot.ts [pilot-id] */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireVaultRoot } from "../lib/engine";
import { spoolDir } from "../lib/spool";
import { isPilotChatId } from "../lib/pilotChatTypes";
import type { PilotTiming } from "../lib/pilotConversation";

const spool = spoolDir(requireVaultRoot());
const directory = join(spool, "pilot-timings");
const requested = process.argv[2];
if (requested && !isPilotChatId(requested)) throw new Error("Expected a Pilot session ID.");
let rows: (PilotTiming & { session: string })[] = [];
try {
  for (const id of readdirSync(directory).filter(isPilotChatId)) {
    if (requested && id !== requested) continue;
    for (const file of readdirSync(join(directory, id)).filter(f => f.endsWith(".json")))
      rows.push({ ...JSON.parse(readFileSync(join(directory, id, file), "utf8")), session: id });
  }
} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const id = requested ?? rows.at(-1)?.session;
rows = rows.filter(r => r.session === id);
const seconds = (ms?: number) => ms === undefined ? "—" : (ms / 1000).toFixed(2);
// Union of tool spans: parallel reads must not count their overlap twice.
function toolWall(t: PilotTiming): number {
  let total = 0, end = 0;
  for (const span of [...t.tools].sort((a, b) => a.startMs - b.startMs)) {
    if (span.endMs === undefined) continue;
    total += Math.max(0, span.endMs - Math.max(end, span.startMs)); end = Math.max(end, span.endMs);
  }
  return total;
}
if (!rows.length) console.log("No recorded Pilot turns yet. Timings are collected on new messages.");
else {
  console.log(`Pilot ${id}; durations in seconds. Subscription model-request counts are not exposed by app-server.`);
  console.table(rows.map(t => ({
    time: t.startedAt, transport: t.transport, status: t.status,
    setup: seconds(t.setupMs), firstText: seconds(t.firstTextMs), total: seconds(t.totalMs),
    tools: t.tools.length, toolWall: seconds(toolWall(t)), apiRequests: t.transport === "api" ? t.apiRequests.length : "—",
  })));
}
