/**
 * A real machine: the image booted, the guest answering over its socket
 * (the plan's Phase 3a VM suite). Runs only when asked, never in the unit
 * suite:
 *
 *   BIGBRAIN_VM_TESTS=vz   bun test packages/agents/test/machine.test.ts   (macOS: bun run vm:build first)
 *   BIGBRAIN_VM_TESTS=qemu bun test packages/agents/test/machine.test.ts   (Linux with KVM: qemu.sh)
 *
 * BIGBRAIN_MACHINE_IMAGE names the image folder (default
 * packages/agents/image/out: `bun run vm:image`, or CI's machine-<arch>
 * artifact with rootfs.img.gz unpacked).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as tcpConnect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EgressProxy } from "../src/proxy";
import { Machine, imageAt } from "../src/machine";
import type { Guest } from "../src/guest";

const BACKEND = process.env.BIGBRAIN_VM_TESTS as "vz" | "qemu" | undefined;
const IMAGE = process.env.BIGBRAIN_MACHINE_IMAGE ?? resolve(import.meta.dir, "../image/out");
const HELPER = BACKEND === "qemu" ? resolve(import.meta.dir, "../image/qemu.sh")
  : process.env.BIGBRAIN_VM_HELPER ?? resolve(import.meta.dir, "../../vm/.build/release/bigbrain-vm");
const enabled = (BACKEND === "vz" || BACKEND === "qemu") && existsSync(join(IMAGE, "rootfs.img"));
if (BACKEND && !enabled) throw new Error(`BIGBRAIN_VM_TESTS=${BACKEND}, but there is no image at ${IMAGE} (bun run vm:image, or unpack CI's artifact there)`);

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); roots.push(d); return d; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Run a command in the guest; its output and exit. */
async function sh(g: Guest, script: string, o: { user?: "work" | "root"; env?: Record<string, string> } = {}) {
  let out = "";
  const x = await g.exec(["/bin/bash", "-c", script], { cwd: "/work", user: o.user, env: o.env }, (_k, d) => { out += d; });
  return { ...(await x.exit), out };
}

describe.skipIf(!enabled)(`a machine (${BACKEND})`, () => {
  let m: Machine, proxy: EgressProxy, upstream: Server, tainted = false;
  const desktop = "orrery-1";
  beforeAll(async () => {
    // an invented upstream the proxy dials for orrery.example, whatever its name resolves to
    // it answers a request, and holds a silent connection (a tunnel) open
    upstream = createServer(s => { s.once("data", () => s.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\norrery")); s.on("error", () => {}); });
    await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
    const port = (upstream.address() as { port: number }).port;
    proxy = new EgressProxy({
      hosts: d => d === desktop && !tainted ? ["orrery.example"] : [],
      dial: async () => new Promise(done => { const s = tcpConnect(port, "127.0.0.1", () => done(s)); }),
    });
    process.env.BIGBRAIN_CANARY_SECRET = "must-not-reach-the-guest";
    m = new Machine({ dir: scratch("machine-"), image: imageAt(IMAGE), backend: BACKEND!, helper: HELPER, memoryMiB: 1024, cpus: 2,
      egress: path => proxy.serveDesktop(desktop, path) });
  });
  afterAll(async () => {
    await m?.stop();
    proxy?.close();
    upstream?.close();
    roots.forEach(r => rmSync(r, { recursive: true, force: true }));
  });

  test("boots, and the guest says hello", async () => {
    const t0 = performance.now();
    const h = await m.start();
    const ms = performance.now() - t0;
    console.log(`  boot to hello: ${Math.round(ms)} ms (${h.arch}, ${h.image})`);
    expect(h.protocol).toBe(1);
    expect(m.state).toBe("running");
    expect(Math.abs(h.booted - Date.now())).toBeLessThan(120_000);
  }, 60_000);

  test("I4: no network device, only loopback; I5: no host environment", async () => {
    const links = await sh(m.guest(), "ls /sys/class/net");
    expect(links.out.trim().split(/\s+/)).toEqual(["lo"]);
    const env = await sh(m.guest(), "env; cat /proc/1/environ | tr '\\0' '\\n'");
    expect(env.out).not.toContain("must-not-reach-the-guest");
    expect(env.out).not.toContain("BIGBRAIN_");
    expect((await sh(m.guest(), "curl -sS -m 3 --noproxy '*' http://1.1.1.1 2>&1; ip route")).out).not.toContain("default");
    if (BACKEND === "vz") {
      const devices = JSON.parse(execFileSync(HELPER, ["--dump-config"], {
        input: JSON.stringify({ kernel: imageAt(IMAGE).kernel, initramfs: imageAt(IMAGE).initramfs, cmdline: "", cpus: 2, memoryMiB: 1024,
          disk: m.disk, console: join(scratch("dump-"), "c.log"), guestSocket: "/tmp/x.sock", egressSocket: "/tmp/y.sock" }) + "\n",
      }).toString()).devices as Record<string, number>;
      expect(Object.keys(devices).every(k => ["block", "vsock", "console", "entropy", "balloon"].includes(k))).toBe(true);
    }
  });

  test("exec streams, runs as work, and closing the connection stops the job", async () => {
    const r = await sh(m.guest(), "id -un; for i in 1 2 3; do echo line $i; done; echo oops >&2; exit 4");
    expect(r).toMatchObject({ code: 4, signal: null });
    expect(r.out).toContain("work\nline 1\nline 2\nline 3\n");
    const g = m.guest();
    const x = await g.exec(["/bin/bash", "-c", "sleep 300 & sleep 300"], { cwd: "/work", grace: 500 }, () => {});
    expect((await g.jobs()).find(j => j.job === x.job)?.exited).toBeNull();
    x.close();
    await x.exit.catch(() => undefined);
    await sleep(1500);
    expect((await sh(g, `ps -o pid= -g ${x.pid} | wc -l`)).out.trim()).toBe("0");
  }, 30_000);

  test("a 50 MB write and read, and a file that belongs to work", async () => {
    const big = Buffer.alloc(50 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
    const g = m.guest();
    let t = performance.now();
    await g.write("/work/orrery/big.bin", big, { parents: true });
    const w = performance.now() - t;
    t = performance.now();
    const back = await g.read("/work/orrery/big.bin");
    const r = performance.now() - t;
    console.log(`  50 MB: write ${(50_000 / w).toFixed(0)} MB/s, read ${(50_000 / r).toFixed(0)} MB/s`);
    expect(back.data.equals(big)).toBe(true);
    expect((await sh(g, "stat -c %U:%G /work/orrery /work/orrery/big.bin")).out).toBe("work:work\nwork:work\n");
  }, 60_000);

  test("the clock: a request steps a skewed guest back to the host's", async () => {
    await sh(m.guest(), "date -s @1000000000 >/dev/null", { user: "root" });
    const r = await sh(m.guest(), "date +%s%3N");
    expect(Math.abs(Number(r.out.trim()) - Date.now())).toBeLessThan(2000);
  });

  test("egress: an allowed host through the proxy; taint closes it, open tunnels too", async () => {
    const g = m.guest();
    const ok = await sh(g, "curl -sS -m 10 http://orrery.example/");
    expect(ok.out).toBe("orrery");
    const refused = await sh(g, "curl -sS -m 10 -o /dev/null -w '%{http_code}' http://elsewhere.example/");
    expect(refused.out).toBe("403");
    // a tunnel held open, then the desktop is tainted
    let held = "";
    const x = await g.exec(["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/3128; printf 'CONNECT orrery.example:443 HTTP/1.1\\r\\n\\r\\n' >&3; head -1 <&3; cat <&3; echo closed"],
      { cwd: "/work" }, (_k, d) => { held += d; });
    for (let i = 0; i < 100 && !held.includes("200"); i++) await sleep(50);
    expect(held).toContain("200 Connection Established");
    tainted = true;
    expect(proxy.drop(desktop)).toBeGreaterThan(0);
    expect(await x.exit).toMatchObject({ code: 0 });
    expect(held).toContain("closed");
    expect((await sh(g, "curl -sS -m 10 -o /dev/null -w '%{http_code}' http://orrery.example/")).out).toBe("403");
    tainted = false;
  }, 60_000);

  test("the helper killed mid-job: the next start recovers, and the disk kept what was written", async () => {
    const g = m.guest();
    await g.write("/work/orrery/notes.txt", "kept\n", { parents: true });
    await sh(g, "sync");
    await g.exec(["/bin/sleep", "300"], { cwd: "/work" }, () => {});
    let told = "";
    (m as unknown as { o: { onExit?: (w: string) => void } }).o.onExit = w => { told = w; };
    // the helper dies (with QEMU, its whole group: the stand-in is three processes)
    process.kill(BACKEND === "qemu" ? -m.pid! : m.pid!, "SIGKILL");
    for (let i = 0; i < 100 && m.state !== "failed"; i++) await sleep(50);
    expect(m.state).toBe("failed");
    expect(told).toContain("stopped");
    await m.start();
    expect((await m.guest().read("/work/orrery/notes.txt")).data.toString()).toBe("kept\n");
    expect((await m.guest().jobs()).length).toBe(0);
  }, 90_000);

  test("stop: the guest powers off cleanly", async () => {
    await m.stop();
    expect(m.state).toBe("stopped");
    expect(m.pid).toBeUndefined();
    if (BACKEND === "qemu") expect(execFileSync("e2fsck", ["-fn", m.disk], { stdio: ["ignore", "pipe", "pipe"] }).toString()).toContain("bigbrain");
  }, 30_000);
});
