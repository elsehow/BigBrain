/**
 * pidLock.ts — the pid-liveness directory lock both single-flight passes
 * use (#642). One shape: a lock DIRECTORY (mkdir is atomic) holding a
 * `pid` file, reclaimed when the holder is gone. The memory pass
 * (lib/memory.ts) and the intake pass (lib/assertionAgent.ts) each carried
 * their own copy, identical but for log lines; this is that copy, once.
 *
 * Liveness is parentWatch's `alive` — the same zero-signal probe the
 * supervisor tree uses, EPERM counted as alive.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive } from "./parentWatch";

/** Take the lock, reclaiming a stale one (holder pid dead or unreadable).
 * `name` labels the console lines the memory pass has always printed; leave
 * it unset for a silent caller. False = a LIVE holder has it. */
export function acquire(dir: string, name?: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), `${process.pid}\n`);
      return true;
    } catch {
      let pid = 0;
      try {
        pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
      } catch {
        /* no pid file — stale */
      }
      if (pid && alive(pid)) {
        if (name) console.log(`${name}: another run holds the lock (pid ${pid}); exiting`);
        return false;
      }
      if (name) console.log(`${name}: reclaiming stale lock`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return false;
}

export function release(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Is the lock held by a LIVE process right now? A pure read — dir held AND
 * its pid alive; a crashed run's stale lock must not read as running (the
 * next acquire reclaims it anyway). */
export function held(dir: string): boolean {
  try {
    const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    return !!pid && alive(pid);
  } catch {
    return false;
  }
}
