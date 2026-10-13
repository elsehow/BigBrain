/** Stage where the memory pass stands, as a run would leave it: a run
 * journal carrying the position (the record's), and the schedule in .state
 * (this computer's). Each record sorts after any already there, so the one
 * staged last is the latest. */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectJournal } from "../../lib/assertionProjection";
import { writeMemorySchedule, type MemoryStamp } from "../../lib/memory";
import { newRunId } from "../../lib/run/journal";
import { MEMORY_JOURNAL_DIR } from "../../lib/runJournal";

export function stageMemoryStamp(root: string, stamp: MemoryStamp): void {
  const dir = join(root, MEMORY_JOURNAL_DIR);
  mkdirSync(dir, { recursive: true });
  const latest = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().at(-1)?.slice(0, -5) ?? "";
  let run = newRunId();
  if (run <= latest) run = `${latest}-staged`;
  writeFileSync(join(dir, `${run}.json`), `${JSON.stringify({ run, startedAt: stamp.lastRunAt ?? new Date().toISOString(), memoryStamp: stamp }, null, 2)}\n`);
  projectJournal(root, `${MEMORY_JOURNAL_DIR}/${run}.json`);
  writeMemorySchedule(root, stamp);
}
