/**
 * Phase 4's egress policy: a contained desktop's TLS to a read host is
 * terminated with this install's CA and each request checked; a push or a
 * write is refused, a fetch goes through; an upload host takes writes; a
 * tunnel host is never terminated; taint keeps only read hosts. A local
 * HTTPS server, under a CA of its own, stands in for the web; every name is
 * invented.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as httpsServer, type Server } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { EgressProxy, MachineCA, permitted, type HostMode } from "../src";

const roots: string[] = [];
const scratch = (n: string) => { const d = mkdtempSync(join(tmpdir(), n)); roots.push(d); return d; };
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

test("permitted: reads, git fetch, and nothing that writes, on a read host", () => {
  expect(permitted("read", "GET", "/orrery/-/orrery-1.0.0.tgz")).toBeUndefined();
  expect(permitted("read", "HEAD", "/")).toBeUndefined();
  expect(permitted("read", "POST", "/invented/orrery.git/git-upload-pack")).toBeUndefined();
  expect(permitted("read", "GET", "/invented/orrery.git/info/refs?service=git-upload-pack")).toBeUndefined();
  expect(permitted("read", "GET", "/invented/orrery.git/info/refs?service=git-receive-pack")).toMatch(/pushes/);
  expect(permitted("read", "POST", "/invented/orrery.git/git-receive-pack")).toMatch(/pushes/);
  expect(permitted("read", "PUT", "/orrery")).toMatch(/PUT writes/);
  expect(permitted("read", "POST", "/-/npm/v1/security/advisories/bulk")).toMatch(/POST writes/);
  expect(permitted("upload", "PUT", "/orrery")).toBeUndefined();
});

describe("the proxy, for a contained desktop", () => {
  const web = new MachineCA({ dir: join(scratch("web-ca-"), "ca") });
  const machines = new MachineCA({ dir: join(scratch("machine-ca-"), "ca") });
  let tainted = false;
  const upstreams = new Map<string, { server: Server; port: number }>();
  const modes: Record<string, HostMode> = { "registry.example": "read", "uploads.example": "upload", "pinned.example": "tunnel" };
  let proxy: EgressProxy, sock = "";
  beforeAll(async () => {
    // "the web": an HTTPS server per invented host, with the web CA's certificate for it
    for (const host of Object.keys(modes)) {
      const server = httpsServer(web.leaf(host), (req, res) => { let body = ""; req.on("data", d => { body += d; }); req.on("end", () => res.end(`${req.method} ${req.url} ${body}`)); });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      upstreams.set(host, { server, port: (server.address() as { port: number }).port });
    }
    proxy = new EgressProxy({
      hosts: () => Object.keys(modes).filter(h => !tainted || modes[h] === "read"),
      mode: (_d, h) => modes[h] ?? "read",
      ca: machines,
      upstream: host => ({ host: "127.0.0.1", port: upstreams.get(host)!.port, ca: web.cert() }),
      dial: async host => new Promise<Socket>(done => { const s = connect(upstreams.get(host)!.port, "127.0.0.1", () => done(s)); }),
    });
    sock = join(scratch("egress-"), "e.sock");
    await proxy.serveDesktop("desk-e1", sock);
  });
  afterAll(() => { proxy?.close(); for (const u of upstreams.values()) u.server.close(); });

  /** CONNECT through the desktop's socket, then TLS trusting `ca` for `host`, then one request; the answer's status and body. */
  async function through(host: string, ca: string, method: string, path: string, body = ""): Promise<{ status: number; text: string }> {
    const raw = connect({ path: sock });
    await new Promise<void>(done => raw.once("connect", () => done()));
    raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    const head = await new Promise<string>(done => { let t = ""; const on = (d: Buffer) => { t += d.toString("latin1"); if (t.includes("\r\n\r\n")) { raw.off("data", on); done(t); } }; raw.on("data", on); });
    if (!head.startsWith("HTTP/1.1 200")) { raw.destroy(); return { status: Number(head.split(" ")[1]), text: head }; }
    const tls = tlsConnect({ socket: raw, servername: host, ca });
    await new Promise<void>((done, fail) => { tls.once("secureConnect", () => done()); tls.once("error", fail); });
    tls.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    const all = await new Promise<string>(done => { let t = ""; tls.on("data", d => { t += d; }); tls.on("close", () => done(t)); tls.on("end", () => done(t)); });
    const [status = "0"] = all.split(" ").slice(1, 2);
    return { status: Number(status), text: all.slice(all.indexOf("\r\n\r\n") + 4) };
  }

  test("a read host: terminated with the machines' CA; reads and git fetches go through, writes and pushes don't", async () => {
    const ca = machines.cert();
    expect(await through("registry.example", ca, "GET", "/orrery")).toEqual({ status: 200, text: "GET /orrery " });
    expect((await through("registry.example", ca, "POST", "/invented/orrery.git/git-upload-pack", "want")).text).toBe("POST /invented/orrery.git/git-upload-pack want");
    const push = await through("registry.example", ca, "POST", "/invented/orrery.git/git-receive-pack", "pack");
    expect(push.status).toBe(403);
    expect(push.text).toMatch(/pushes to a repository, and this host is read-only/);
    expect((await through("registry.example", ca, "PUT", "/orrery", "{}")).status).toBe(403);
    // the web's own CA isn't what the machine sees: the proxy's certificate is
    await expect(through("registry.example", web.cert(), "GET", "/")).rejects.toThrow();
  });

  test("an upload host takes writes; a tunnel host is the web's own certificate, end to end", async () => {
    expect(await through("uploads.example", machines.cert(), "PUT", "/orrery", "{}")).toEqual({ status: 200, text: "PUT /orrery {}" });
    expect((await through("pinned.example", web.cert(), "POST", "/anything", "x")).status).toBe(200);
    await expect(through("pinned.example", machines.cert(), "GET", "/")).rejects.toThrow();
  });

  test("taint keeps the read hosts and closes the rest", async () => {
    tainted = true;
    try {
      expect((await through("registry.example", machines.cert(), "GET", "/orrery")).status).toBe(200);
      expect((await through("uploads.example", machines.cert(), "PUT", "/x")).status).toBe(403);
      expect((await through("pinned.example", web.cert(), "GET", "/")).status).toBe(403);
    } finally { tainted = false; }
  });
});
