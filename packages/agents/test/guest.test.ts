/**
 * The guest protocol's conformance suite (PROTOCOL.md): the real guest,
 * `bigbrain-guest --serve`, on a Unix socket, driven by the host's client
 * (src/guest.ts); and the client against a guest that breaks the protocol.
 * Needs the guest built (`bun run guest:build`); without it the guest half
 * is skipped, never faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONTROL_CAP, DATA_CAP, FrameReader, Guest, GuestError, KIND, clean, control, encode } from "../src/guest";

const BIN = process.env.BIGBRAIN_GUEST_BIN ?? ["release", "debug"].map(p => resolve(import.meta.dir, `../../guest/target/${p}/bigbrain-guest`)).find(existsSync);
const unix = process.platform !== "win32";
if (!BIN && process.env.BIGBRAIN_GUEST_REQUIRED) throw new Error("BIGBRAIN_GUEST_REQUIRED, and no guest is built: bun run guest:build");

const roots: string[] = [];
const scratch = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), name))); roots.push(d); return d; };
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(25); }
  return check();
}

/** Send raw bytes to the guest and collect what it answers until it closes;
 * with `close`, close first (bun can't half-close and still read). */
function raw(path: string, bytes: Buffer, close = false): Promise<Buffer> {
  return new Promise((done, fail) => {
    const s = connect({ path }, () => { s.write(bytes); if (close) s.end(); });
    const got: Buffer[] = [];
    s.on("data", (d: Buffer) => got.push(d));
    s.on("error", fail);
    s.on("close", () => done(Buffer.concat(got)));
  });
}
function frames(b: Buffer) {
  const r = new FrameReader(); r.push(b);
  const out = [];
  for (let f = r.next(); f; f = r.next()) out.push(f);
  return out;
}

describe.skipIf(!BIN || !unix)("bigbrain-guest --serve", () => {
  let child: ChildProcess, sock: string, g: Guest, dir: string;
  beforeAll(async () => {
    dir = scratch("guest-");
    sock = join(scratch("guest-sock-"), "g.sock");
    child = spawn(BIN!, ["--serve", "--unix", sock], { stdio: ["ignore", "ignore", "inherit"] });
    await until(() => existsSync(sock));
    g = new Guest(sock, { tz: "Etc/UTC" });
  });
  afterAll(() => child?.kill("SIGKILL"));

  test("hello names the protocol", async () => {
    const h = await g.hello();
    expect(h.protocol).toBe(1);
    expect(h.arch).toBeTruthy();
    expect(h.booted).toBeLessThanOrEqual(Date.now());
  });

  test("write, stat, read and list round-trip, with hashes", async () => {
    const p = join(dir, "notes", "orbit.txt");
    await expect(g.write(p, "first\n")).rejects.toMatchObject({ code: "not-found" });
    const w = await g.write(p, "first\n", { parents: true, ifMatch: null });
    expect(w.sha256).toBe(sha("first\n"));
    expect(readFileSync(p, "utf8")).toBe("first\n");
    const st = await g.stat(p, true);
    expect(st).toMatchObject({ kind: "file", size: 6, mode: 0o644, sha256: sha("first\n") });
    const r = await g.read(p);
    expect(r.data.toString()).toBe("first\n");
    expect(r.sha256).toBe(sha("first\n"));
    expect((await g.read(p, { offset: 2, length: 3 })).data.toString()).toBe("rst");
    expect((await g.list(join(dir, "notes"))).entries).toEqual([{ name: "orbit.txt", kind: "file" }]);
  });

  test("ifMatch: a write against a changed file is a conflict, and writes nothing", async () => {
    const p = join(dir, "moon.txt");
    const first = await g.write(p, "phase 1\n");
    writeFileSync(p, "phase 2, from elsewhere\n");
    await expect(g.write(p, "phase 1 edited\n", { ifMatch: first.sha256 })).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(p, "utf8")).toBe("phase 2, from elsewhere\n");
    await expect(g.write(p, "x", { ifMatch: null })).rejects.toMatchObject({ code: "conflict" });
    await g.write(p, "phase 3\n", { ifMatch: sha("phase 2, from elsewhere\n") });
    expect(readFileSync(p, "utf8")).toBe("phase 3\n");
  });

  test("a write follows a link to its target; stat reports the link itself", async () => {
    writeFileSync(join(dir, "real.txt"), "a");
    symlinkSync(join(dir, "real.txt"), join(dir, "alias.txt"));
    await g.write(join(dir, "alias.txt"), "b");
    expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("b");
    expect((await g.stat(join(dir, "alias.txt"))).kind).toBe("link");
  });

  test("errors are typed", async () => {
    await expect(g.read(join(dir, "missing"))).rejects.toMatchObject({ code: "not-found" });
    await expect(g.read(dir)).rejects.toMatchObject({ code: "is-directory" });
    writeFileSync(join(dir, "plain"), "");
    await expect(g.list(join(dir, "plain"))).rejects.toMatchObject({ code: "not-directory" });
    await expect(g.stat("relative/path")).rejects.toMatchObject({ code: "bad-request" });
    await expect(g.stopJob(9999)).rejects.toMatchObject({ code: "no-such-job" });
  });

  test("a 50 MB write and read", async () => {
    const big = Buffer.alloc(50 * 1024 * 1024, 7);
    big.write("orrery", 1234);
    const t0 = performance.now();
    await g.write(join(dir, "big.bin"), big);
    const back = await g.read(join(dir, "big.bin"));
    expect(back.data.equals(big)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(20_000);
  }, 30_000);

  test("exec streams stdout and stderr and reports the exit", async () => {
    const out: string[] = [], err: string[] = [];
    const x = await g.exec(["/bin/sh", "-c", "echo out; echo err >&2; exit 3"], { cwd: dir }, (k, d) => (k === "stdout" ? out : err).push(d.toString()));
    expect(await x.exit).toEqual({ code: 3, signal: null });
    expect(out.join("")).toBe("out\n");
    expect(err.join("")).toBe("err\n");
  });

  test("exec's environment is exactly what the host sends", async () => {
    let text = "";
    const x = await g.exec(["/usr/bin/env"], { cwd: dir, env: { ORRERY: "1" } }, (_k, d) => { text += d; });
    await x.exit;
    expect(text.trim().split("\n").sort()).toEqual(["ORRERY=1"]);
  });

  test("stdin, then closing it", async () => {
    let text = "";
    const x = await g.exec(["/bin/cat"], { cwd: dir, stdin: true }, (_k, d) => { text += d; });
    await x.write("saturn\n");
    await x.write(Buffer.alloc(0));
    expect(await x.exit).toEqual({ code: 0, signal: null });
    expect(text).toBe("saturn\n");
  });

  test("a missing program is not-found; a missing cwd too", async () => {
    await expect(g.exec(["/no/such/program"], { cwd: dir }, () => {})).rejects.toMatchObject({ code: "not-found" });
    await expect(g.exec(["/bin/true"], { cwd: join(dir, "nowhere") }, () => {})).rejects.toMatchObject({ code: "not-found" });
  });

  test("closing exec's connection stops the job's whole group", async () => {
    const x = await g.exec(["/bin/sh", "-c", "sleep 60 & sleep 60"], { cwd: dir, grace: 500 }, () => {});
    expect(alive(x.pid)).toBe(true);
    x.close();
    await x.exit.catch(() => undefined);
    expect(await until(() => !alive(x.pid))).toBe(true);
  });

  test("a detached job outlives its connection; job.stop ends it", async () => {
    const x = await g.exec(["/bin/sh", "-c", "echo up; exec sleep 60"], { cwd: dir }, () => {});
    await g.detach(x.job);
    x.close();
    await sleep(300);
    expect(alive(x.pid)).toBe(true);
    const listed = (await g.jobs()).find(j => j.job === x.job)!;
    expect(listed.exited).toBeNull();
    expect((await g.jobOutput(x.job)).data.toString()).toBe("up\n");
    await g.stopJob(x.job, 500);
    expect(alive(x.pid)).toBe(false);
    expect(await until(async () => (await g.jobs()).find(j => j.job === x.job)?.exited?.signal === "SIGTERM")).toBe(true);
  });

  test("job.output keeps the last 256 KiB and says where it starts", async () => {
    const x = await g.exec(["/bin/sh", "-c", "head -c 300000 /dev/zero | tr '\\0' a"], { cwd: dir }, () => {});
    await x.exit;
    const o = await g.jobOutput(x.job);
    expect(o.to).toBe(300_000);
    expect(o.from).toBe(300_000 - 256 * 1024);
    expect(o.data.length).toBe(256 * 1024);
    expect((await g.jobOutput(x.job, 299_990)).data.toString()).toBe("aaaaaaaaaa");
  });

  test("ports finds a job's listener; connect reaches it", async () => {
    const script = "const s=require('net').createServer(c=>c.end('hello from orrery')).listen(0,'127.0.0.1',()=>console.log(s.address().port))";
    let printed = "";
    const x = await g.exec([process.execPath, "-e", script], { cwd: dir, env: { PATH: process.env.PATH ?? "" } }, (_k, d) => { printed += d; });
    expect(await until(() => /\d+/.test(printed))).toBe(true);
    const port = Number(printed.trim());
    const found = await until(async () => (await g.ports()).some(p => p.port === port && p.job === x.job));
    expect(found).toBe(true);
    expect((await g.jobs()).find(j => j.job === x.job)!.ports).toEqual([port]);
    const s = await g.connect(port);
    const body = await new Promise<string>(done => { let t = ""; s.on("data", d => { t += d; }); s.on("close", () => done(t)); s.resume(); });
    expect(body).toBe("hello from orrery");
    x.close();
    await expect(g.connect(1)).rejects.toMatchObject({ code: "not-found" });
  });

  describe("hostile frames get a typed refusal, and the guest lives on", () => {
    const refusal = async (bytes: Buffer) => {
      const fs = frames(await raw(sock, bytes));
      expect(fs.length).toBe(1);
      expect(fs[0]!.kind).toBe(KIND.control);
      return (fs[0] as { control: Record<string, unknown> }).control;
    };
    const header = (kind: number, length: number) => { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32BE(length, 1); return h; };
    test.each([
      ["an oversized control frame", header(0, CONTROL_CAP + 1)],
      ["a 4 GiB length", header(0, 0xffffffff)],
      ["an oversized data frame", header(4, DATA_CAP + 1)],
      ["an unknown kind", header(9, 2)],
      ["non-UTF-8", encode(0, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))],
      ["deeply nested JSON", encode(0, Buffer.from(`{"op":${"[".repeat(10_000)}${"]".repeat(10_000)}}`))],
      ["a JSON array", encode(0, Buffer.from("[1]"))],
      ["a data frame first", encode(4, Buffer.from("x"))],
      ["an unknown op", control({ op: "format-disk" })],
      ["an unknown key", control({ op: "stat", path: "/", hash: false, follow: true })],
      ["a mistyped field", control({ op: "stat", path: 7, hash: false })],
      ["a missing field", control({ op: "read", path: "/" })],
      ["a path with NUL", control({ op: "stat", path: "/a\u0000b", hash: false })],
      ["an over-long path", control({ op: "stat", path: "/" + "a".repeat(5000), hash: false })],
      ["a negative offset", control({ op: "read", path: "/", offset: -1, length: 1 })],
    ])("%s", async (_name, bytes) => {
      const a = await refusal(bytes);
      expect(a).toMatchObject({ ok: false, error: "bad-request" });
      expect((await g.hello()).protocol).toBe(1);
    });
    test.each([
      ["a truncated frame", Buffer.concat([header(0, 100), Buffer.from("{\"op\":")])],
      ["a truncated header", Buffer.from([0, 0])],
      ["a write cut short", Buffer.concat([control({ op: "write", path: "/tmp/never", size: 10, parents: false }), encode(4, Buffer.from("abc"))])],
    ])("%s, then the host gone", async (_name, bytes) => {
      await raw(sock, bytes, true);
      expect((await g.hello()).protocol).toBe(1);
    });
  });

  test("64 open connections, then limit", async () => {
    const held: Socket[] = [];
    for (let i = 0; i < 64; i++) held.push(await new Promise<Socket>(done => { const s = connect({ path: sock }, () => done(s)); }));
    await sleep(100);
    const a = frames(await raw(sock, control({ op: "hello", protocol: 1, tz: "" })));
    expect((a[0] as { control: Record<string, unknown> }).control).toMatchObject({ ok: false, error: "limit" });
    held.forEach(s => s.destroy());
    await until(async () => { try { await g.hello(); return true; } catch { return false; } });
    expect((await g.hello()).protocol).toBe(1);
  });
});

describe("the client refuses a guest that breaks the protocol", () => {
  let server: Server, sock: string;
  let answer: (s: Socket, request: Record<string, unknown>) => void = () => {};
  beforeAll(async () => {
    sock = join(scratch("fake-guest-"), "g.sock");
    server = createServer(s => {
      const r = new FrameReader();
      s.on("data", (d: Buffer) => { r.push(d); try { const f = r.next(); if (f?.kind === 0) answer(s, f.control); } catch { s.destroy(); } });
      s.on("error", () => {});
    });
    await new Promise<void>(done => server.listen(sock, done));
  });
  afterAll(() => server?.close());
  const g = () => new Guest(sock, { answerMs: 300 });
  const reply = (...bufs: Buffer[]) => { answer = s => { for (const b of bufs) s.write(b); s.end(); }; };

  test.each([
    ["an extra key", control({ ok: true, kind: "file", size: 1, mtime: 0, mode: 420, path: "/Users/someone" })],
    ["a wrong type", control({ ok: true, kind: "file", size: "1", mtime: 0, mode: 420 })],
    ["an unknown kind", control({ ok: true, kind: "socket", size: 1, mtime: 0, mode: 420 })],
    ["an unknown error code", control({ ok: false, error: "rm-rf", message: "x" })],
    ["a data frame for an answer", encode(KIND.data, Buffer.from("x"))],
    ["an oversized frame", Buffer.from([0, 0xff, 0xff, 0xff, 0xff])],
    ["an unknown frame kind", Buffer.from([7, 0, 0, 0, 0])],
  ])("%s", async (_name, bytes) => {
    reply(bytes);
    const e = await g().stat("/x").catch(e => e);
    expect(e).toBeInstanceOf(GuestError);
    expect(e.code).toBe("protocol");
  });

  test("a read that sends more than it said, or the wrong bytes", async () => {
    reply(control({ ok: true, size: 3, length: 3, sha256: sha("abc") }), encode(KIND.data, Buffer.from("abcd")));
    expect((await g().read("/x").catch(e => e)).code).toBe("protocol");
    reply(control({ ok: true, size: 3, length: 3, sha256: sha("abc") }), encode(KIND.data, Buffer.from("xyz")));
    expect((await g().read("/x").catch(e => e)).code).toBe("protocol");
  });

  test("a write whose hash isn't what was sent", async () => {
    answer = s => { s.write(control({ ok: true, sha256: sha("other") })); s.end(); };
    expect((await g().write("/x", "mine").catch(e => e)).code).toBe("protocol");
  });

  test("silence is a timeout; a guest's message is cleaned", async () => {
    answer = () => {};
    expect((await g().hello().catch(e => e)).code).toBe("timeout");
    reply(control({ ok: false, error: "internal", message: "bad\u001b[31m\nthing" + "x".repeat(1000) }));
    const e = await g().stat("/x").catch(e => e);
    expect(e.code).toBe("internal");
    expect(e.message).not.toMatch(/[\u0000-\u001f]/);
    expect(e.message.length).toBeLessThanOrEqual(300);
  });

  test("the host refuses what it must not send", async () => {
    await expect(g().stat("relative")).rejects.toMatchObject({ code: "bad-request" });
    await expect(g().exec(Array(257).fill("x"), { cwd: "/" }, () => {})).rejects.toMatchObject({ code: "bad-request" });
    expect(clean("a\u202eb")).toBe("a b");
  });
});

test("FrameReader refuses a bad header before buffering its payload", () => {
  const r = new FrameReader();
  r.push(Buffer.from([0, 0x7f, 0xff, 0xff, 0xff]));
  expect(() => r.next()).toThrow(/cap/);
  const ok = new FrameReader();
  const f = control({ a: 1 });
  ok.push(f.subarray(0, 3)); expect(ok.next()).toBeUndefined();
  ok.push(f.subarray(3)); expect(ok.next()).toEqual({ kind: 0, control: { a: 1 } });
});

