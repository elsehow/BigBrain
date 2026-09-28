import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spoolDir } from "./spool";
import type { WorkSession } from "./workHistory";

export function readWorkSession(root: string, path: string): WorkSession | null {
  const id = /^sessions\/(work-[a-f0-9]{32})\.md$/.exec(path)?.[1];
  if (!id) return null;
  const file = join(spoolDir(root), "work-sessions", `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as WorkSession;
}
