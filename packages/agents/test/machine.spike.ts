/**
 * The spike (docs/plans/2026-10-12-contained-desktops.md, "Spike:
 * measurements and thresholds"): boots real machines and measures each row
 * of the plan's table against its go and no-go thresholds. Never in CI.
 *
 *   bun run vm:build                      # macOS: the helper, ad-hoc signed
 *   bun packages/agents/test/machine.spike.ts [--quick] [--image <dir>] [--out <file>]
 *
 * --quick idles one minute instead of five. The report is markdown, printed
 * and written to --out (default: spike-results.md in the current folder),
 * ready to append to the plan's "Spike results". Every project here is
 * invented. On Linux (BIGBRAIN_VM_TESTS=qemu) it runs under QEMU, to test
 * the spike itself; those numbers are not the plan's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { EgressProxy } from "../src/proxy";
import { DEFAULT_HOSTS } from "../src/sandbox";
import { Machine, cloneDisk, consoleTail, imageAt } from "../src/machine";
import type { Guest } from "../src/guest";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const QUICK = flag("--quick");
const BACKEND: "vz" | "qemu" = process.env.BIGBRAIN_VM_TESTS === "qemu" ? "qemu" : "vz";
const IMAGE = resolve(option("--image") ?? process.env.BIGBRAIN_MACHINE_IMAGE ?? resolve(import.meta.dir, "../image/out"));
const HELPER = BACKEND === "qemu" ? resolve(import.meta.dir, "../image/qemu.sh")
  : resolve(option("--helper") ?? process.env.BIGBRAIN_VM_HELPER ?? resolve(import.meta.dir, "../../vm/.build/release/bigbrain-vm"));
const OUT = resolve(option("--out") ?? "spike-results.md");

type Verdict = "go" | "between" | "no-go" | "not run";
interface Row { measure: string; result: string; verdict: Verdict; note?: string }
const rows: Row[] = [];
function record(measure: string, result: string, verdict: Verdict, note?: string) {
  rows.push({ measure, result, verdict, note });
  console.log(`${verdict === "go" ? "✓" : verdict === "no-go" ? "✗" : verdict === "between" ? "~" : "-"} ${measure}: ${result}${note ? ` (${note})` : ""}`);
}
/** go when value ≤ go, no-go when > nogo, between otherwise (smaller is better). */
const judge = (value: number, go: number, nogo: number): Verdict => value <= go ? "go" : value > nogo ? "no-go" : "between";
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); roots.push(d); return d; };
const machines: Machine[] = [];

async function sh(g: Guest, script: string, o: { user?: "work" | "root"; cwd?: string } = {}) {
  let out = "";
  const x = await g.exec(["/bin/bash", "-lc", script], { cwd: o.cwd ?? "/work", user: o.user }, (_k, d) => { out += d; });
  return { ...(await x.exit), out };
}

/** The image folder, with rootfs.img unpacked from CI's rootfs.img.gz if that is all there is. */
function image() {
  const img = imageAt(IMAGE);
  if (!existsSync(img.rootfs) && existsSync(`${img.rootfs}.gz`)) {
    console.log("unpacking rootfs.img.gz …");
    if (spawnSync("sh", ["-c", `gunzip -c "${img.rootfs}.gz" > "${img.rootfs}"`]).status !== 0) throw new Error("couldn't unpack rootfs.img.gz");
  }
  for (const f of [img.kernel, img.initramfs, img.rootfs]) if (!existsSync(f)) throw new Error(`missing ${f}: bun run vm:image, or unpack CI's machine-${arch() === "arm64" ? "arm64" : "amd64"} artifact into ${IMAGE}`);
  return img;
}

/** The egress proxy the machines reach the internet through: the default package hosts. */
const proxy = new EgressProxy({ hosts: () => [...DEFAULT_HOSTS, "deb.debian.org", "nodejs.org"] });

function machine(name: string, memoryMiB = 2048): Machine {
  const m = new Machine({ dir: join(scratch(`spike-${name}-`), "vm"), image: image(), backend: BACKEND, helper: HELPER, memoryMiB, cpus: 2,
    egress: path => proxy.serveDesktop(name, path) });
  machines.push(m);
  return m;
}

/** An invented Node project: a few dozen packages, a vite page, a test. */
function fixture(dir: string) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "orrery", private: true, type: "module",
    scripts: { dev: "vite --host 127.0.0.1 --port 5173 --strictPort", test: "vitest run" },
    devDependencies: { vite: "6.3.5", vitest: "3.2.4" },
  }, null, 2));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Orrery</title><script type=module src=/src/main.js></script><p>Orrery</p>\n");
  writeFileSync(join(dir, "src", "main.js"), "export const ratio = (a, b) => a / b;\nif (globalThis.document) document.title = 'Orrery ' + ratio(4, 2);\n");
  writeFileSync(join(dir, "src", "ratio.test.js"), "import { test, expect } from 'vitest';\nimport { ratio } from './main.js';\ntest('ratio', () => expect(ratio(4, 2)).toBe(2));\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=orrery@example.invalid", "-c", "user.name=Orrery", ...a], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-qm", "orrery"); git("tag", "v0.1");
  git("checkout", "-qb", "moons"); writeFileSync(join(dir, "MOONS.md"), "Io, Europa\n"); git("add", "-A"); git("commit", "-qm", "moons"); git("checkout", "-q", "main");
}

/** Every file of a folder written into the guest, under `to`. */
async function copyIn(g: Guest, from: string, to: string) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: from }).toString().split("\n").filter(Boolean);
  for (const f of files) await g.write(`${to}/${f}`, readFileSync(join(from, f)), { parents: true });
}

/** Resident memory (KiB) of the processes that are a machine: the helper, and on macOS the framework's VM service. */
function resident(m: Machine): number {
  const ps = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="]).toString().split("\n").map(l => l.trim().split(/\s+/));
  const pids = new Set([m.pid]);
  let total = 0;
  for (const [pid, ppid, rss, ...comm] of ps) {
    const name = comm.join(" ");
    if (pids.has(Number(pid)) || pids.has(Number(ppid)) || name.includes("com.apple.Virtualization.VirtualMachine") || name.includes("qemu-system")) {
      pids.add(Number(pid)); total += Number(rss);
    }
  }
  return total;
}

/** CPU seconds the machines' processes have used so far (ps's cumulative TIME: [[dd-]hh:]mm:ss[.ss]). */
function cpuSeconds(): number {
  const ps = execFileSync("ps", ["-axo", "time=,comm="]).toString().split("\n").map(l => l.trim()).filter(Boolean);
  let total = 0;
  for (const l of ps) {
    if (!l.includes("com.apple.Virtualization.VirtualMachine") && !l.includes("qemu-system") && !l.includes("bigbrain-vm")) continue;
    const t = l.split(/\s+/)[0]!;
    const [days, rest] = t.includes("-") ? [Number(t.split("-")[0]), t.split("-")[1]!] : [0, t];
    total += days * 86400 + rest.split(":").map(Number).reduce((acc, x) => acc * 60 + x, 0);
  }
  return total;
}

/** A host loopback port joined to a guest port: the preview forward of Phase 3c, in miniature. */
function forward(g: Guest, port: number): Promise<{ port: number; server: Server }> {
  const server = createServer(client => {
    // held by hand: bun's paused server socket doesn't give back what it buffered on resume
    const early: Buffer[] = [];
    const hold = (d: Buffer) => early.push(d);
    client.on("data", hold);
    client.on("error", () => client.destroy());
    g.connect(port).then(up => {
      client.off("data", hold);
      for (const b of early) up.write(b);
      client.pipe(up); up.pipe(client); up.resume();
      up.on("error", () => client.destroy()); client.on("close", () => up.destroy());
    }).catch(() => client.destroy());
  });
  return new Promise(done => server.listen(0, "127.0.0.1", () => done({ port: (server.address() as { port: number }).port, server })));
}

async function timeFetch(url: string, n = 10): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); const r = await fetch(url); await r.text(); times.push(performance.now() - t); }
  return p50(times);
}

async function main() {
  console.log(`spike: ${BACKEND}, ${platform()} ${release()} ${arch()}, ${cpus().length} CPUs, ${Math.round(totalmem() / 2 ** 30)} GiB, image ${IMAGE}\n`);
  const img = image();

  // ── boot ──
  const a = machine("a");
  let hello;
  try { hello = await a.start(); }
  catch (e) {
    record("ad-hoc signed helper boots a machine", `refused: ${(e as Error).message}`, "no-go", consoleTail(a.consoleLog, 10).replace(/\n/g, " / "));
    return;
  }
  record("ad-hoc signed helper boots a machine", `boots (${hello.arch}, guest ${hello.agent})`, "go");
  const lsmod = await sh(a.guest(), "cat /proc/modules | cut -d' ' -f1 | sort | tr '\\n' ' '; echo; ls /dev/vda /dev/hvc0 /dev/hwrng 2>&1 | tr '\\n' ' '");
  record("modules", "/dev/vda, vsock, rng and console up before hello", lsmod.code === 0 && !lsmod.out.includes("No such") ? "go" : "no-go", lsmod.out.trim().replace(/\n/g, " · "));
  record("built-in against modules", "not measured (needs a one-off kernel)", "not run");
  await a.stop();

  const boots: number[] = [];
  for (let i = 0; i < (QUICK ? 5 : 10); i++) {
    const t = performance.now(); await a.start(); boots.push(performance.now() - t); await a.stop();
  }
  const boot = p50(boots);
  record(`boot to hello (p50 of ${boots.length})`, `${(boot / 1000).toFixed(2)} s (${boots.map(b => (b / 1000).toFixed(1)).join(", ")})`, judge(boot, 2000, 5000));

  // ── image and disk ──
  const gz = existsSync(`${img.rootfs}.gz`) ? statSync(`${img.rootfs}.gz`).size : 0;
  const download = gz + statSync(img.kernel).size + statSync(img.initramfs).size;
  record("image download", gz ? `${(download / 1e6).toFixed(0)} MB` : "rootfs.img.gz not present", gz ? judge(download / 1e6, 300, 500) : "not run");
  const cloneDir = scratch("spike-clone-");
  const before = Number(execFileSync("df", ["-k", cloneDir]).toString().trim().split("\n").pop()!.split(/\s+/)[3]);
  let t = performance.now(); cloneDisk(img.rootfs, join(cloneDir, "disk.img")); const clone = performance.now() - t;
  const after = Number(execFileSync("df", ["-k", cloneDir]).toString().trim().split("\n").pop()!.split(/\s+/)[3]);
  const grew = (before - after) / 1024;
  record("disk clone", `${(clone / 1000).toFixed(2)} s; free space fell ${grew.toFixed(0)} MB`, clone <= 1000 && grew < 200 ? "go" : clone > 10_000 ? "no-go" : "between",
    grew >= 200 ? "a full copy, not a clone" : undefined);

  // ── one machine, the fixture ──
  await a.start();
  const g = a.guest();
  const project = scratch("spike-orrery-");
  fixture(project);
  await copyIn(g, project, "/work/orrery");
  await sh(g, "rm -rf ~/.bun/install/cache");
  t = performance.now();
  const install = await sh(g, "cd /work/orrery && bun install 2>&1 | tail -3");
  const installMs = performance.now() - t;
  const du = await sh(a.guest(), "du -sm /work/orrery/node_modules | cut -f1; ls /work/orrery/node_modules | wc -l");
  record("bun install, cold cache, through the proxy", install.code === 0 ? `${(installMs / 1000).toFixed(1)} s (${du.out.trim().replace("\n", " MB, ")} packages)` : `failed: ${install.out.trim().slice(-200)}`,
    install.code === 0 ? judge(installMs, 60_000, 180_000) : "no-go");
  const growth = (Number(execFileSync("du", ["-sk", a.disk]).toString().split(/\s+/)[0]) / 1024);
  record("disk after bun install", `${growth.toFixed(0)} MB allocated of 8 GiB`, "go");

  if (install.code === 0) {
    const guestRuns: number[] = [];
    let failed = "";
    for (let i = 0; i < 3; i++) { t = performance.now(); const r = await sh(g, "cd /work/orrery && bun run test 2>&1"); guestRuns.push(performance.now() - t); if (r.code !== 0) failed = r.out.trim().slice(-300); }
    let hostMs = NaN;
    const hostInstall = spawnSync("bun", ["install"], { cwd: project, stdio: "ignore" });
    if (hostInstall.status === 0) {
      const hostRuns: number[] = [];
      for (let i = 0; i < 3; i++) { t = performance.now(); spawnSync("bun", ["run", "test"], { cwd: project, stdio: "ignore" }); hostRuns.push(performance.now() - t); }
      hostMs = p50(hostRuns);
    }
    const ratio = p50(guestRuns) / hostMs;
    if (failed) record("test run", `the fixture's tests failed in the machine: ${failed}`, "no-go");
    else record("test run", `${(p50(guestRuns) / 1000).toFixed(2)} s in the machine, ${(hostMs / 1000).toFixed(2)} s on the host: ${ratio.toFixed(1)}×`, Number.isFinite(ratio) ? judge(ratio, 2, 4) : "not run");

    // preview through a forward
    const dev = await g.exec(["/bin/bash", "-lc", "cd /work/orrery && exec bun run dev"], { cwd: "/work/orrery" }, () => {});
    let listening = false;
    for (let i = 0; i < 100 && !listening; i++) { listening = (await g.ports()).some(p => p.port === 5173); if (!listening) await sleep(100); }
    if (listening) {
      const f = await forward(g, 5173);
      const guestPage = await timeFetch(`http://127.0.0.1:${f.port}/src/main.js`);
      f.server.close();
      const host = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", "5199", "--strictPort"], { cwd: project, stdout: "ignore", stderr: "ignore" });
      let hostPage = NaN;
      for (let i = 0; i < 100; i++) { try { await fetch("http://127.0.0.1:5199/"); hostPage = await timeFetch("http://127.0.0.1:5199/src/main.js"); break; } catch { await sleep(100); } }
      host.kill();
      const ratio = guestPage / hostPage;
      record("preview", `${guestPage.toFixed(1)} ms through the forward, ${hostPage.toFixed(1)} ms on the host: ${ratio.toFixed(1)}×`, Number.isFinite(ratio) ? judge(ratio, 2, 5) : "not run");
    } else record("preview", "vite never listened", "no-go");
    dev.close();
  }

  // ── protocol costs ──
  const op = async (n: number, f: () => Promise<unknown>) => { const xs: number[] = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); await f(); xs.push(performance.now() - t0); } return p50(xs); };
  await g.write("/work/four.bin", Buffer.alloc(4096, 1));
  const stat = await op(1000, () => g.stat("/work/four.bin"));
  const read = await op(1000, () => g.read("/work/four.bin"));
  const write = await op(1000, () => g.write("/work/four.bin", Buffer.alloc(4096, 2)));
  const worst = Math.max(stat, read, write);
  record("file ops (p50 of 1,000)", `stat ${stat.toFixed(1)} ms, read 4 KB ${read.toFixed(1)} ms, write 4 KB ${write.toFixed(1)} ms`, judge(worst, 5, 25));
  const big = Buffer.alloc(50 * 1024 * 1024, 5);
  t = performance.now(); await g.write("/work/big.bin", big); const bw = 50 / ((performance.now() - t) / 1000);
  t = performance.now(); await g.read("/work/big.bin"); const br = 50 / ((performance.now() - t) / 1000);
  const slow = Math.min(bw, br);
  record("bulk transfer", `write ${bw.toFixed(0)} MB/s, read ${br.toFixed(0)} MB/s`, slow >= 50 ? "go" : slow < 10 ? "no-go" : "between");
  const execs = await op(100, async () => { const x = await g.exec(["/bin/true"], { cwd: "/work" }, () => {}); await x.exit; });
  record("exec round trip (p50 of 100)", `${execs.toFixed(1)} ms`, judge(execs, 50, 250));

  // ── bundle round trip ──
  const state = scratch("spike-bundle-");
  execFileSync("git", ["bundle", "create", join(state, "in.bundle"), "--all"], { cwd: project, stdio: "ignore" });
  await g.write("/work/.in/orrery.bundle", readFileSync(join(state, "in.bundle")), { parents: true });
  const cloned = await sh(g, "rm -rf /work/copy && git clone -q /work/.in/orrery.bundle /work/copy && cd /work/copy && for b in $(git branch -r | grep -v HEAD); do git branch -q --track ${b#origin/} $b 2>/dev/null; done; git bundle create -q /work/.out/orrery.bundle --branches --tags && echo ok");
  const out = await g.read("/work/.out/orrery.bundle");
  writeFileSync(join(state, "out.bundle"), out.data);
  const refs = (b: string) => execFileSync("git", ["bundle", "list-heads", b]).toString().trim().split("\n").filter(l => !l.endsWith(" HEAD")).sort().join("\n");
  const same = cloned.code === 0 && refs(join(state, "in.bundle")) === refs(join(state, "out.bundle"));
  record("bundle round trip", same ? "identical refs" : `mismatch: ${cloned.out.trim().slice(-200)}`, same ? "go" : "no-go");

  // ── idle ──
  const idleMin = QUICK ? 1 : 5;
  console.log(`idling ${idleMin} min …`);
  const cpu0 = cpuSeconds(), t0 = performance.now();
  await sleep(idleMin * 60_000);
  const cpu = (cpuSeconds() - cpu0) / ((performance.now() - t0) / 1000) * 100;
  const rss = resident(a) / 1024;
  record(`idle footprint (after ${idleMin} min)`, `${rss.toFixed(0)} MB resident`, judge(rss, 400, 1024));
  record(`idle CPU (${idleMin} min)`, `${cpu.toFixed(1)} %`, judge(cpu, 2, 10));

  // ── three at once ──
  const b = machine("b"), c = machine("c");
  const swapBefore = swapUsed();
  try {
    await Promise.all([b.start(), c.start()]);
    for (const m of [b, c]) { await copyIn(m.guest(), project, "/work/orrery"); await sh(m.guest(), "cd /work/orrery && bun install >/dev/null 2>&1"); }
    const swapAfter = swapUsed();
    const total = (resident(a) + resident(b) + resident(c)) / 1024;
    record("three at once", `${total.toFixed(0)} MB resident for three; swap ${swapBefore.toFixed(0)} → ${swapAfter.toFixed(0)} MB`, swapAfter - swapBefore > 256 ? "no-go" : "go");
  } catch (e) { record("three at once", `failed: ${(e as Error).message}`, "no-go"); }

  record("clock after the Mac sleeps", "by hand: bun packages/agents/test/machine.spike.ts --clock", "not run");
}

function swapUsed(): number {
  try {
    if (platform() === "darwin") return Number(/used = ([\d.]+)M/.exec(execFileSync("sysctl", ["vm.swapusage"]).toString())?.[1] ?? 0);
    const m = /SwapTotal:\s+(\d+).*SwapFree:\s+(\d+)/s.exec(readFileSync("/proc/meminfo", "utf8"));
    return m ? (Number(m[1]) - Number(m[2])) / 1024 : 0;
  } catch { return 0; }
}

/** --clock: one machine, its skew from the host every 10 s. Sleep the Mac in the middle and wake it. */
async function clock() {
  const m = machine("clock");
  await m.start();
  console.log("Close the lid (or choose Sleep from the Apple menu) for 10 minutes, then wake the Mac. Each line is guest minus host, after one request. Ctrl-C ends.");
  for (;;) {
    const r = await sh(m.guest(), "date +%s%3N");
    console.log(`${new Date().toISOString()}  ${Number(r.out.trim()) - Date.now()} ms`);
    await sleep(10_000);
  }
}

function report(): string {
  const mark = (v: Verdict) => ({ go: "go", between: "between", "no-go": "**no-go**", "not run": "not run" })[v];
  return [
    `### Spike results (${new Date().toISOString().slice(0, 10)}, ${BACKEND}, ${platform()} ${release()} ${arch()}, ${cpus().length} CPUs, ${Math.round(totalmem() / 2 ** 30)} GiB)`,
    "",
    "| measure | result | verdict |",
    "|---|---|---|",
    ...rows.map(r => `| ${r.measure} | ${r.result}${r.note ? ` (${r.note.replace(/\|/g, "/")})` : ""} | ${mark(r.verdict)} |`),
    "",
  ].join("\n");
}

const cleanup = async () => {
  await Promise.all(machines.map(m => m.stop().catch(() => m.kill())));
  proxy.close();
  roots.forEach(r => rmSync(r, { recursive: true, force: true }));
};
process.on("SIGINT", () => { void cleanup().then(() => process.exit(130)); });

if (flag("--clock")) await clock();
else {
  try { await main(); }
  catch (e) { record("the spike itself", `stopped: ${(e as Error).message}`, "no-go"); }
  finally {
    await cleanup();
    const text = report();
    writeFileSync(OUT, text);
    console.log(`\n${text}\nWritten to ${OUT}`);
  }
}
