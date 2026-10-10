/** The arrivals queue: where every arrival waits for the firewall. Only
 * lib/door.ts reads or writes it (test/door.test.ts).
 *
 * An item here has not been screened yet, so it sits OUTSIDE the vault,
 * where agents work and every read jail is rooted, under ~/.config/bigbrain,
 * which desktops and Pilot are denied; lib/workPermissions.ts names this
 * folder among the credential stores as well, so an override is denied too.
 * One owner-only file per arrival in owner-only folders. An arrival leaves
 * once it is screened; what became of it, never its content, is kept a week
 * so its sender can ask. */

import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { configDir } from "./engine";
import { arrivalsOverride } from "./env";
import { createAtomic, writeAtomic } from "./fsx";
import { sha256hex } from "./hash";
import type { Attachment, IntakeErrorCode, IntakeReceipt } from "./intake";
import type { StagedItem } from "./stageStorage";

export type Arrival =
  /** The owner's drop, for the record. `raw` is its duplicate identity (lib/intake.ts). */
  | { to: "record"; source: string; content: string; raw: string; attachments: Attachment[] }
  /** A poller's find, for staging; the worth gate decides from there. */
  | { to: "staging"; item: StagedItem };

export type Outcome =
  | { state: "landed"; receipt: IntakeReceipt }
  | { state: "staged"; fresh: boolean }
  | { state: "withheld" }
  | { state: "refused"; code: IntakeErrorCode; error: string };

const KEPT_MS = 7 * 24 * 3600_000;
const ID_RE = /^[0-9a-f]{64}$/;

/** The folder every vault's queue sits in. */
export const arrivalsBase = (): string => resolve(arrivalsOverride() ?? join(configDir(), "arrivals"));

function vaultDir(root: string): string {
  let path: string;
  try { path = realpathSync(root); } catch { path = resolve(root); }
  return join(arrivalsBase(), sha256hex(path).slice(0, 12));
}
const queuePath = (root: string, id: string): string => join(vaultDir(root), "queue", `${id}.json`);
const outcomePath = (root: string, id: string): string => join(vaultDir(root), "done", `${id}.json`);

/** One worker at a time screens this vault's arrivals. */
export const workerLock = (root: string): string => join(vaultDir(root), "worker.sqlite");

/** The identity the record already uses for a duplicate, so a retried clip
 * or a re-polled find is queued once. */
function arrivalId(a: Arrival): string {
  return sha256hex(JSON.stringify(a.to === "record" ? [a.to, a.source, a.raw, a.attachments] : [a.to, a.item.source, a.item.id]));
}

/** Queue an arrival. An id already waiting keeps its first copy. */
export function putArrival(root: string, a: Arrival): string {
  const id = arrivalId(a);
  createAtomic(queuePath(root, id), JSON.stringify(a), 0o600);
  return id;
}

export function readArrival(root: string, id: string): Arrival | undefined {
  if (!ID_RE.test(id)) return undefined;
  try { return JSON.parse(readFileSync(queuePath(root, id), "utf8")) as Arrival; }
  catch { return undefined; }
}

/** What is waiting, oldest first. Reads no item. */
export function waitingIds(root: string): string[] {
  const dir = join(vaultDir(root), "queue");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => ID_RE.test(n.slice(0, -5)) && n.endsWith(".json"))
    .flatMap((n) => {
      try { return [{ id: n.slice(0, -5), at: statSync(join(dir, n)).mtimeMs }]; } catch { return []; }
    })
    .sort((a, b) => a.at - b.at)
    .map((e) => e.id);
}

/** Its outcome is kept before the arrival leaves, so a crash between the
 * two leaves an arrival that settles at once on its next turn. */
export function settleArrival(root: string, id: string, o: Outcome): void {
  writeAtomic(outcomePath(root, id), JSON.stringify(o), 0o600);
  rmSync(queuePath(root, id), { force: true });
}

export function arrivalOutcome(root: string, id: string): Outcome | undefined {
  if (!ID_RE.test(id)) return undefined;
  try { return JSON.parse(readFileSync(outcomePath(root, id), "utf8")) as Outcome; }
  catch { return undefined; }
}

/** Forget outcomes older than a week. */
export function pruneOutcomes(root: string, now = Date.now()): void {
  const dir = join(vaultDir(root), "done");
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    try { if (now - statSync(join(dir, n)).mtimeMs > KEPT_MS) rmSync(join(dir, n), { force: true }); } catch { /* gone already */ }
  }
}
