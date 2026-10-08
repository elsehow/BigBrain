/** queueHead.test.ts — the two things the home feed's column head says
 * about TIME and DEPTH, both of which used to be constants:
 *
 *   · `nextEtaMs` was `jobs.length ? 0 : null` — "the gate is open" the
 *     instant anything was due, which the labels render as "now". With a
 *     300s tick and no wake, the run was on average 2.5 min away.
 *   · `running` was the literal 0, so the spinner could never say a round
 *     had started.
 *
 * These were dueFeed's tests. #666 retired the rest of that payload (the
 * job rows, the run histories, the observations — the work view's, and
 * the work view went with #498), so the per-row `state` assertions went
 * with it: they said the same thing the running/waiting split says, from
 * the side that no longer exists.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireAssertionLock } from "../lib/assertionAgent";
import { queueHead, TEND_TICK_MS } from "../lib/queueHead";
import type { Hold } from "../lib/sqliteLock";
import { writeNextFires } from "../lib/supervisorClock";
import { insertionSeq, nativeVault } from "./support/vault";

const insertion = insertionSeq((n) => ({
  body: `Body of item ${n}.`,
  envelope: { id: `src-${n}`, kind: "web-clip" },
}));

const vault = (n: number): string =>
  nativeVault({
    prefix: "bb-queuehead-",
    files: { "vault.yaml": "integrations: {}\n" }, // loadManifest wants a document
    insertions: Array.from({ length: n }, () => insertion()),
  });

/** Hold the intake lock as a running round does, until the test ends. */
const holds: Hold[] = [];
afterEach(() => { for (const hold of holds.splice(0)) hold.release(); });
const holdIntakeLock = (root: string): void => { holds.push(acquireAssertionLock(root)!); };

const feed = queueHead;

describe("nextEtaMs — a schedule when one is published, a bound when not", () => {
  test("nothing due: no eta and no chip", () => {
    const f = feed(vault(0));
    expect(f.nextEtaMs).toBeNull();
  });

  test("no supervisor (a launchd install): the eta is a floor, so the tick rides along", () => {
    const f = feed(vault(1));
    expect(f.nextEtaMs).toBe(0);
    expect(f.tickMs).toBe(TEND_TICK_MS);
  });

  test("a live supervisor's clock is reported, and needs no hedge", () => {
    const root = vault(1);
    writeNextFires(root, { tend: Date.now() + 240_000 });
    const f = feed(root);
    expect(f.nextEtaMs).toBeGreaterThan(235_000);
    expect(f.nextEtaMs).toBeLessThanOrEqual(240_000);
    expect(f.tickMs).toBeNull(); // exact: the label must not say "within ~5m"
  });

  test("a clock already past reads 0 — the next beat fires it — and still no hedge", () => {
    const root = vault(1);
    writeNextFires(root, { tend: Date.now() - 5_000 });
    const f = feed(root);
    expect(f.nextEtaMs).toBe(0);
    expect(f.tickMs).toBeNull();
  });

  test("a stamp for another job does not answer for tend", () => {
    const root = vault(1);
    writeNextFires(root, { publish: Date.now() + 900_000 });
    const f = feed(root);
    expect(f.nextEtaMs).toBe(0);
    expect(f.tickMs).toBe(TEND_TICK_MS);
  });
});

describe("running — the lock's answer, not the clock's", () => {
  test("no lock: everything due is waiting", () => {
    expect(feed(vault(3))).toMatchObject({ waiting: 3, running: 0 });
  });

  test("a held lock moves the batch in flight to running", () => {
    const root = vault(3);
    holdIntakeLock(root);
    expect(feed(root)).toMatchObject({ waiting: 0, running: 3 });
  });

  test("beyond one batch, the overflow stays waiting — a round claims at most 8", () => {
    const root = vault(11);
    holdIntakeLock(root);
    expect(feed(root)).toMatchObject({ waiting: 3, running: 8 });
  });

  test("the total is unchanged by the split — the feed's count must not move", () => {
    const root = vault(5);
    const before = feed(root);
    holdIntakeLock(root);
    const after = feed(root);
    expect(after.waiting + after.running).toBe(before.waiting + before.running);
  });

  test("a dead run's record, with no hold behind it, does not read as running", () => {
    const root = vault(2);
    holdIntakeLock(root);
    holds.pop()!.release();
    writeFileSync(join(root, ".state", "assertion.lock.holder"), `${JSON.stringify({ pid: 2147483647 })}\n`);
    expect(feed(root)).toMatchObject({ waiting: 2, running: 0 });
  });
});
