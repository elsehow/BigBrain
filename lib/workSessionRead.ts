import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spoolDir } from "./spool";
import { savedWork, type WorkSession } from "./workHistory";

export function readWorkSession(root: string, path: string): WorkSession | null {
  const id = /^sessions\/(work-[a-f0-9]{32})\.md$/.exec(path)?.[1];
  if (!id) return null;
  for (const directory of ["work-sessions", "workers", "external-agents"]) {
    const file = join(spoolDir(root), directory, `${id}.json`);
    if (!existsSync(file)) continue;
    const session = savedWork.parse(JSON.parse(readFileSync(file, "utf8"))) as WorkSession;
    if (session.id !== id) return null;
    return session;
  }
  return null;
}
