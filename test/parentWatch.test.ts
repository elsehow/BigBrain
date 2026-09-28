/**
 * lib/parentWatch.ts (#597): a child of the desktop supervisor dies when the
 * supervisor does — including when the supervisor was SIGKILLed and could
 * not say anything — and a script with no supervisor watches nothing.
 */
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { engineIdentity } from "../lib/engine";
import { alive, dieWithSupervisor, supervisorPid, watchPid } from "../lib/parentWatch";

const LIB = resolve(import.meta.dir, "..", "lib", "parentWatch.ts");

const until = async (what: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (what()) return true;
    await Bun.sleep(50);
  }
  return what();
};

test("alive: this process yes, launchd yes (EPERM), an exited one no", () => {
  expect(alive(process.pid)).toBe(true);
  expect(alive(1)).toBe(true);
  const done = spawnSync("true");
  expect(alive(done.pid)).toBe(false);
});

test("watchPid fires once the pid is gone, and can be stopped", async () => {
  const victim = spawn("sleep", ["60"]);
  await until(() => alive(victim.pid!), 1000);
  let fired = 0;
  const stop = watchPid(victim.pid!, () => fired++, 20);
  await Bun.sleep(80);
  expect(fired).toBe(0);
  victim.kill("SIGKILL");
  expect(await until(() => fired === 1, 2000)).toBe(true);
  await Bun.sleep(80);
  expect(fired).toBe(1); // once
  stop();
});

test("supervisorPid and engineIdentity read BIGBRAIN_SUPERVISOR_PID, and refuse nonsense", () => {
  const was = process.env["BIGBRAIN_SUPERVISOR_PID"];
  try {
    delete process.env["BIGBRAIN_SUPERVISOR_PID"];
    expect(supervisorPid()).toBeNull();
    expect(engineIdentity().supervisor).toBeNull();
    process.env["BIGBRAIN_SUPERVISOR_PID"] = "4242";
    expect(supervisorPid()).toBe(4242);
    expect(engineIdentity().supervisor).toBe(4242);
    for (const bad of ["", "x", "0", "1", "-5", "3.5"]) {
      process.env["BIGBRAIN_SUPERVISOR_PID"] = bad;
      expect(supervisorPid()).toBeNull();
      expect(engineIdentity().supervisor).toBeNull();
    }
    process.env["BIGBRAIN_SUPERVISOR_PID"] = String(process.pid); // never watch yourself
    expect(supervisorPid()).toBe(process.pid);
    expect(engineIdentity().supervisor).toBe(process.pid);
    expect(dieWithSupervisor("setup door")).toBeNull();
  } finally {
    if (was === undefined) delete process.env["BIGBRAIN_SUPERVISOR_PID"];
    else process.env["BIGBRAIN_SUPERVISOR_PID"] = was;
  }
});

/** A real process tree: parent → child, the child watching the parent the
 * way api/web watch bin/desktop.ts. Returns both pids once the child says
 * what it is watching. */
async function tree(withSupervisor: boolean): Promise<{ parent: ReturnType<typeof spawn>; child: number; watching: string; lines: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "parentwatch-"));
  const childScript = join(dir, "child.ts");
  const parentScript = join(dir, "parent.ts");
  writeFileSync(
    childScript,
    `import { dieWithSupervisor } from ${JSON.stringify(LIB)};\n` +
      `console.log("watching " + dieWithSupervisor("child"));\n` +
      `setInterval(() => {}, 1000);\n`
  );
  writeFileSync(
    parentScript,
    `import { spawn } from "node:child_process";\n` +
      `const env = { ...process.env };\n` +
      `delete env.BIGBRAIN_SUPERVISOR_PID;\n` +
      (withSupervisor ? `env.BIGBRAIN_SUPERVISOR_PID = String(process.pid);\n` : "") +
      `const c = spawn(process.execPath, [${JSON.stringify(childScript)}], { env, stdio: ["ignore", "inherit", "inherit"] });\n` +
      `console.log("child " + c.pid);\n` +
      `setInterval(() => {}, 1000);\n`
  );
  const parent = spawn(process.execPath, [parentScript], { stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  let out = "";
  parent.stdout!.on("data", (d: Buffer) => {
    out += d.toString();
    lines.splice(0, lines.length, ...out.split("\n").filter(Boolean));
  });
  expect(await until(() => lines.some((l) => l.startsWith("child ")) && lines.some((l) => l.startsWith("watching ")), 10_000)).toBe(true);
  const child = Number(lines.find((l) => l.startsWith("child "))!.slice(6));
  const watching = lines.find((l) => l.startsWith("watching "))!.slice(9);
  return { parent, child, watching, lines };
}

test("a child dies with a SIGKILLed supervisor — the one that could not say goodbye", async () => {
  const { parent, child, watching } = await tree(true);
  try {
    expect(watching).toBe(String(parent.pid));
    expect(alive(child)).toBe(true);
    parent.kill("SIGKILL");
    expect(await until(() => !alive(child), 5000)).toBe(true);
  } finally {
    parent.kill("SIGKILL");
    try {
      process.kill(child, "SIGKILL");
    } catch {
      /* already gone — the point */
    }
  }
}, 15_000);

test("with no supervisor pid (launchd, a hand-run script) nothing is watched and the child stays", async () => {
  const { parent, child, watching } = await tree(false);
  try {
    expect(watching).toBe("null");
    parent.kill("SIGKILL");
    await Bun.sleep(1500);
    expect(alive(child)).toBe(true); // outlived its parent, as a launchd job would
  } finally {
    parent.kill("SIGKILL");
    try {
      process.kill(child, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}, 15_000);
