/**
 * LocalGuests: one guest per desktop, under the confinement it had when it
 * started; a changed confinement gets a new guest and the old one drains.
 * The launcher here confines nothing (sandbox.test.ts is Seatbelt's, on
 * macOS): what is tested is when guests start and stop.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Harbor, LocalGuests, NO_GUEST, type Confinement, type Launcher } from "../src";

const built = ["release", "debug"].some(p => existsSync(resolve(import.meta.dir, `../../guest/target/${p}/bigbrain-guest`))) || !!process.env.BIGBRAIN_GUEST_BIN;
const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function counting() {
  const launches: Array<{ confine: Confinement; pid?: number }> = [];
  const dir = mkdtempSync(join(tmpdir(), "guests-"));
  roots.push(dir);
  const launcher: Launcher = {
    launch: async job => { launches.push({ confine: job.confine }); return { file: "/bin/bash", args: ["-c", job.command], env: { ...job.env, ADDED_BY_LAUNCHER: "yes" } }; },
    tmp: () => dir,
  };
  return { launches, launcher };
}
const confine = (write: string[]): Confinement => ({ desktop: "desk-g", write, worktrees: [], untrusted: false });

describe.skipIf(!built)("local guests", () => {
  test("one guest serves a desktop until its confinement changes; the old one drains, then stops", async () => {
    const { launches, launcher } = counting();
    const guests = new LocalGuests({ env: { PATH: process.env.PATH }, launcher, discovery: false });
    const h = new Harbor({ guests, settleMs: 300, waitMs: 1000, graceMs: 300 });
    expect((await h.run("desk-g", "echo one", tmpdir(), undefined, confine(["/a"]))).status).toBe("exited");
    expect((await h.run("desk-g", "echo two", tmpdir(), undefined, confine(["/a"]))).status).toBe("exited");
    await h.files("desk-g", confine(["/a"]));
    expect(launches.length).toBe(1);

    // a long job on the first guest, then the confinement shrinks
    const long = await h.run("desk-g", "echo waiting; sleep 30", tmpdir(), undefined, confine(["/a"]));
    expect(long.status).toBe("running");
    const first = h.job(long.job)!;
    expect((await h.run("desk-g", "echo three", tmpdir(), undefined, confine([]))).status).toBe("exited");
    expect(launches.length).toBe(2);
    // the old guest keeps its job, under what it started with
    await sleep(300);
    expect(alive(first.pid)).toBe(true);
    await h.stopJob(first.id);
    expect(first.exited).toBeTruthy();
    expect(await guests.stopDesktop("desk-g")).toBeGreaterThan(0);
  });

  test("a command's environment: the launcher's additions, and withheld names asked each time", async () => {
    const { launches, launcher } = counting();
    const withheld: string[] = [];
    const h = new Harbor({ env: { PATH: process.env.PATH, PROVIDER_KEY: "invented", BIGBRAIN_VAULT: "/v" }, withheld: () => withheld, launcher, discovery: false });
    const r1 = await h.run("desk-e", "echo key=$PROVIDER_KEY added=$ADDED_BY_LAUNCHER vault=$BIGBRAIN_VAULT tag=$BIGBRAIN_AGENT_DESKTOP", tmpdir());
    expect(r1.output.trim()).toBe("key=invented added=yes vault= tag=desk-e");
    withheld.push("PROVIDER_KEY");
    expect((await h.run("desk-e", "echo key=$PROVIDER_KEY", tmpdir())).output.trim()).toBe("key=");
    expect(launches.length).toBe(1);
    await h.stopDesktop("desk-e");
  });

  test("a launcher that refuses runs nothing, and says why", async () => {
    const h = new Harbor({ env: {}, launcher: { launch: async () => { throw new Error("refused for the test"); } }, discovery: false });
    await expect(h.run("desk-r", "touch /tmp/never", tmpdir())).rejects.toThrow("refused for the test");
  });

  test("a guest that dies at once is a refusal, not a hang", async () => {
    const h = new Harbor({ env: {}, discovery: false, launcher: { launch: async () => ({ file: "/bin/sh", args: ["-c", "echo no sandbox here >&2; exit 3"], env: {} }) } });
    await expect(h.run("desk-d", "true", tmpdir())).rejects.toThrow(/could not start this desktop's guest \(no sandbox here\)/);
  });
});

test("without a built guest, the tools say how to build one", async () => {
  const g = new LocalGuests({ guest: "", discovery: false, launcher: { launch: async () => ({ file: "/bin/true", args: [], env: {} }) } });
  await expect(g.files("desk-n", confine([]))).rejects.toThrow(NO_GUEST);
});
