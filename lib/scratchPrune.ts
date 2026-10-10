/**
 * scratchPrune.ts — a session's scratch folder (`.spool/workspaces/<id>`,
 * lib/pilotAccess.ts) outlives the session, and nothing else ever removes
 * it (#217): one vault held 99 of them, 2.3 GB, almost all for sessions long
 * archived. Scratch is the agent's private notes and handoffs; what it found
 * worth keeping went to the vault with `drop`. So once a session is archived
 * (closed and ingested, no turn running) and has been idle for KEEP_DAYS,
 * its scratch goes. A folder no session names any more goes once it has sat
 * as long. Reopening an archived session starts its scratch anew.
 *
 * Only `pilot-`/`work-` folders, never through a link. Run by the supervisor
 * (bin/prune.ts).
 */

import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "./pilotAccess";
import { spoolDir } from "./spool";

export const KEEP_DAYS = 14;
const SCRATCH = /^(?:pilot|work)-[a-f0-9]{32}$/u;

type Saved = { deactivatedAt?: string; lifecycle?: string; turn?: unknown; lastActivityAt?: string; updated?: string };

export function pruneSessionScratch(root: string, { now = Date.now(), keepDays = KEEP_DAYS } = {}): { removed: string[] } {
  const dir = scratchRoot(root), chats = join(spoolDir(root), "pilot-chats");
  const cutoff = now - keepDays * 86_400_000;
  const idle = (at: string | undefined): boolean => !!at && Date.parse(at) < cutoff;
  // a record that can't be read is still a session's (the viewer keeps it), never an orphan
  const saved = (id: string): Saved | "none" | "unreadable" => {
    try { return JSON.parse(readFileSync(join(chats, `${id}.json`), "utf8")) as Saved; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unreadable"; }
  };
  let names: string[];
  try { names = readdirSync(dir); } catch { return { removed: [] }; }
  const removed: string[] = [];
  for (const name of names) {
    if (!SCRATCH.test(name)) continue;
    const path = join(dir, name), stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;
    const s = saved(name);
    if (s === "unreadable") continue;
    const done = s === "none"
      ? stat.mtimeMs < cutoff
      : !!s.deactivatedAt && s.lifecycle === "ingested" && !s.turn && idle(s.lastActivityAt ?? s.updated);
    if (!done) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return { removed };
}
