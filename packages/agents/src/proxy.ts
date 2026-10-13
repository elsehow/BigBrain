/**
 * proxy.ts — the one way desktops' commands reach beyond this machine.
 *
 * Their sandbox (sandbox.ts) lets them connect only to loopback, and their
 * environment names this proxy (HTTP_PROXY, HTTPS_PROXY…). It serves HTTPS
 * by CONNECT tunnel and plain HTTP by absolute URL, on ports 80 and 443, to
 * the hosts the allowlist names, and refuses any name that resolves to this
 * machine or a private network: the host's servers and the person's LAN stay
 * out of reach whatever the allowlist says. Upstream addresses are the ones
 * checked, so a name can't resolve one way for the check and another for the
 * connection. It is raw TCP (node:net), not node:http's CONNECT upgrade.
 *
 * Each desktop's commands name it with that desktop's credential as the
 * proxy URL's user and password (credential), so a connection that carries
 * it is known to be theirs and reaches that desktop's hosts too. Another
 * desktop can't make it: it is keyed by a secret only this process holds.
 * A contained desktop's machine needs no credential: it reaches the proxy
 * only through its own Unix socket (serveDesktop), so the socket says whose
 * a connection is. drop() closes a desktop's open connections, the moment
 * its hosts shrink (the plan's D9: a desktop that read outside material
 * loses the network).
 *
 * For a contained desktop's connections, with a CA (egressPolicy.ts), the
 * proxy terminates TLS for an allowlisted host in "read" or "upload" mode,
 * so it sees each request and applies the host's mode: a read host takes
 * reads and git fetches, never a write or a push. "tunnel" hosts, and every
 * sandboxed desktop's connection (whose commands don't trust this CA), get
 * an opaque tunnel as before.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lookup as lookupCb, type LookupAddress } from "node:dns";
import { request as httpsRequest, createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, connect, createServer, isIP, type Server, type Socket } from "node:net";
import { permitted, type HostMode, type MachineCA } from "./egressPolicy";

const HEAD_MAX = 32_768, HEAD_MS = 15_000;
const PORTS = new Set([80, 443]);

/** Addresses no allowlisted name may resolve to: this machine, private and link-local networks. */
const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");
export const privateAddress = (address: string): boolean => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  return mapped ? PRIVATE.check(mapped, "ipv4") : PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
};

/** Whether an allowlist names a host: exactly, or `*.example.com` for its subdomains. */
export function allowedHost(host: string, allowlist: Iterable<string>): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const raw of allowlist) {
    const a = raw.trim().toLowerCase().replace(/\.$/, "");
    if (a === h || (a.startsWith("*.") && h.endsWith(a.slice(1)) && h.length > a.length - 1)) return true;
  }
  return false;
}

/** Connect to an allowlisted host: its first address, once none is private. */
async function dialPublic(host: string, port: number): Promise<Socket> {
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map(a => a.address);
  if (!addresses.length) throw new Error(`${host} did not resolve`);
  if (addresses.some(privateAddress)) throw new Refusal(`${host} resolves to this machine or a private network`);
  const s = connect({ host: addresses[0], port });
  s.setTimeout(HEAD_MS, () => s.destroy(new Error(`${host} did not answer`)));
  return dialed(s).then(() => { s.setTimeout(0); return s; });
}

/** DNS for terminated requests: a name that resolves to this machine or a private network is refused. */
function publicLookup(hostname: string, options: object, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void): void {
  lookupCb(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    if (!list.length || list.some(a => privateAddress(a.address))) return callback(new Error(`${hostname} resolves to this machine or a private network`), "");
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

const dialed = (s: Socket) => new Promise<Socket>((done, fail) => { s.once("connect", () => done(s)); s.once("error", fail); });

class Refusal extends Error {}

export interface EgressOptions {
  /** Hosts commands may reach, asked per connection: `desktop` when its credential says whose it is. */
  hosts: (desktop?: string) => Iterable<string>;
  /** How to ask for a host off the list, said when one is refused. */
  ask?: string;
  /** A host's mode for a desktop (egressPolicy.ts). Absent: every allowed host is a tunnel. */
  mode?: (desktop: string | undefined, host: string) => HostMode;
  /** The CA a contained desktop's machine trusts: with it, read and upload hosts are terminated and their requests checked. */
  ca?: MachineCA;
  /** Told when a desktop's connection is refused a host off its list: the host shows it. */
  refused?: (desktop: string, host: string) => void;
  /** Where a terminated request goes instead of the host itself, and the CA its certificate is checked against; tests stand in a local upstream. */
  upstream?: (host: string, port: number) => { host: string; port: number; ca: string };
  /** How an allowed connection is made; tests stand in a local upstream. */
  dial?: (host: string, port: number) => Promise<Socket>;
}

export class EgressProxy {
  private server?: Server;
  private listening?: Promise<number>;
  private key = randomBytes(32);
  private desktopServers = new Map<string, Server>();
  /** One TLS server per terminated host, on loopback, with that host's certificate. */
  private terminators = new Map<string, Promise<{ server: HttpsServer; port: number }>>();
  /** A terminator's inbound connection (by the connecting socket's port) → whose it is. */
  private inbound = new Map<number, { desktop: string; host: string; port: number }>();
  /** Each desktop's open connections, client and upstream, for drop(). */
  private open = new Map<string, Set<Socket>>();
  constructor(private options: EgressOptions) {}

  /** Serve one desktop's machine on a Unix socket of its own: every connection there is that desktop's. */
  serveDesktop(desktop: string, path: string): Promise<void> {
    this.desktopServers.get(desktop)?.close();
    return new Promise<void>((done, fail) => {
      const server = createServer(socket => this.serve(socket, desktop));
      server.once("error", fail);
      server.listen(path, () => { server.unref(); done(); });
      this.desktopServers.set(desktop, server);
    });
  }

  /** Stop serving a desktop's machine and close its open connections. */
  unserveDesktop(desktop: string): void {
    this.desktopServers.get(desktop)?.close();
    this.desktopServers.delete(desktop);
    this.drop(desktop);
  }

  /** Close every open connection of a desktop's: what it may reach has just changed. */
  drop(desktop: string): number {
    const sockets = this.open.get(desktop);
    if (!sockets) return 0;
    const n = sockets.size;
    for (const s of sockets) s.destroy();
    this.open.delete(desktop);
    return n;
  }

  private track(desktop: string, ...sockets: Socket[]): void {
    let set = this.open.get(desktop);
    if (!set) this.open.set(desktop, set = new Set());
    for (const s of sockets) {
      set.add(s);
      s.once("close", () => { set!.delete(s); if (!set!.size && this.open.get(desktop) === set) this.open.delete(desktop); });
    }
  }

  /** A desktop's credential, the password its commands' proxy URL carries. */
  credential(desktop: string): string {
    return createHmac("sha256", this.key).update(desktop).digest("base64url");
  }

  /** The desktop a request's Proxy-Authorization names, when its credential is right. */
  private desktopOf(auth: string | undefined): string | undefined {
    const basic = auth && /^basic\s+([\w+/=-]+)$/i.exec(auth.trim())?.[1];
    if (!basic) return undefined;
    const pair = Buffer.from(basic, "base64").toString("utf8"), at = pair.indexOf(":");
    if (at < 1) return undefined;
    const desktop = pair.slice(0, at), want = Buffer.from(this.credential(desktop)), got = Buffer.from(pair.slice(at + 1));
    return want.length === got.length && timingSafeEqual(want, got) ? desktop : undefined;
  }

  /** The proxy's port on 127.0.0.1, starting it on first use. It never keeps the process alive. */
  port(): Promise<number> {
    return this.listening ??= new Promise<number>((done, fail) => {
      const server = createServer(socket => this.serve(socket));
      server.once("error", e => { this.listening = undefined; fail(e); });
      server.listen(0, "127.0.0.1", () => { server.unref(); done((server.address() as { port: number }).port); });
      this.server = server;
    });
  }

  close(): void {
    this.server?.close(); this.server = undefined; this.listening = undefined;
    for (const t of this.terminators.values()) void t.then(x => x.server.close(), () => undefined);
    this.terminators.clear();
    // a copy: unserveDesktop deletes from the map being walked
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const d of [...this.desktopServers.keys()]) this.unserveDesktop(d);
  }

  /** A connection to this host's terminator, registered as the desktop's. */
  private async terminate(desktop: string, host: string, port: number): Promise<Socket> {
    const t = await this.terminator(host);
    const inner = connect({ host: "127.0.0.1", port: t.port });
    await new Promise<void>((done, fail) => { inner.once("connect", () => done()); inner.once("error", fail); });
    const key = inner.localPort!;
    this.inbound.set(key, { desktop, host, port });
    inner.once("close", () => this.inbound.delete(key));
    return inner;
  }

  private terminator(host: string): Promise<{ server: HttpsServer; port: number }> {
    let t = this.terminators.get(host);
    if (!t) {
      t = new Promise((done, fail) => {
        const { key, cert } = this.options.ca!.leaf(host);
        const server = createHttpsServer({ key, cert, ALPNProtocols: ["http/1.1"] }, (req, res) => this.relay(req, res));
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => { server.unref(); done({ server, port: (server.address() as { port: number }).port }); });
      });
      this.terminators.set(host, t);
      t.catch(() => this.terminators.delete(host));
    }
    return t;
  }

  /** One request inside a terminated tunnel: checked against the host's mode for its desktop, then sent on, its answer streamed back. */
  private relay(req: IncomingMessage, res: ServerResponse): void {
    const who = this.inbound.get(req.socket.remotePort ?? -1);
    const deny = (status: number, text: string) => { res.writeHead(status, { "content-type": "text/plain", connection: "close" }); res.end(`${text}\n`); };
    if (!who) return deny(403, "BigBrain's sandbox refused this request: it isn't any desktop's.");
    const { desktop, host, port } = who;
    // what may be reached is asked again: taint may have closed it since the tunnel opened
    if (!allowedHost(host, this.options.hosts(desktop))) return deny(403, `BigBrain's sandbox refused ${host}: it is not on this desktop's network allowlist now.`);
    const mode = this.options.mode?.(desktop, host) ?? "tunnel";
    const why = permitted(mode, req.method ?? "GET", req.url ?? "/");
    if (why) {
      this.options.refused?.(desktop, host);
      return deny(403, `BigBrain's sandbox refused ${req.method} ${host}${(req.url ?? "").split("?")[0]}: ${why}. Your person can mark the host "may upload" in Settings.`);
    }
    const headers = { ...req.headers };
    for (const h of ["proxy-connection", "proxy-authorization", "connection", "keep-alive", "upgrade"]) delete headers[h];
    const to = this.options.upstream?.(host, port);
    const up = httpsRequest({ host: to?.host ?? host, port: to?.port ?? port, servername: host, method: req.method, path: req.url, headers, timeout: HEAD_MS,
      ...(to ? { ca: to.ca } : { lookup: publicLookup }) }, upRes => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage ?? "", upRes.headers);
      upRes.pipe(res);
    });
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.on("error", () => { if (!res.headersSent) deny(502, `Could not reach ${host}.`); else res.destroy(); });
    req.pipe(up);
  }

  private serve(client: Socket, known?: string): void {
    client.on("error", () => client.destroy());
    client.setTimeout(HEAD_MS, () => client.destroy());
    let head = Buffer.alloc(0);
    const take = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0 && head.length <= HEAD_MAX) return;
      client.off("data", take);
      if (end < 0) return answer(client, 431, "Request headers too large.");
      client.pause();
      client.setTimeout(0);
      this.forward(client, head.subarray(0, end).toString("latin1").split("\r\n"), head.subarray(end + 4), known).catch(() => client.destroy());
    };
    client.on("data", take);
  }

  private async forward(client: Socket, lines: string[], rest: Buffer, known?: string): Promise<void> {
    const [method = "", target = "", version = "HTTP/1.1"] = lines[0]!.split(" ");
    let host: string, port: number, request: Buffer | undefined;
    if (method === "CONNECT") {
      const m = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(target);
      if (!m) return answer(client, 400, "CONNECT needs host:port.");
      host = m[1]!; port = Number(m[2]);
    } else {
      let url: URL;
      try { url = new URL(target); } catch { return answer(client, 400, "This proxy takes absolute http:// URLs and CONNECT."); }
      if (url.protocol !== "http:") return answer(client, 400, "This proxy takes absolute http:// URLs and CONNECT.");
      host = url.hostname.replace(/^\[|\]$/g, ""); port = Number(url.port || 80);
      // one request per connection, so a second on it can't name another host
      const headers = lines.slice(1).filter(l => !/^(proxy-[\w-]+|connection|keep-alive)\s*:/i.test(l));
      request = Buffer.from([`${method} ${url.pathname}${url.search} ${version}`, ...headers, "Connection: close", "", ""].join("\r\n"), "latin1");
    }
    const auth = lines.slice(1).find(l => /^proxy-authorization\s*:/i.test(l));
    const desktop = known ?? this.desktopOf(auth?.slice(auth.indexOf(":") + 1));
    const refuse = (why: string, status = 403) => answer(client, status, `BigBrain's sandbox refused ${host}:${port}: ${why}.`,
      status === 407 ? ['Proxy-Authenticate: Basic realm="BigBrain"'] : []);
    if (!PORTS.has(port)) return refuse("only ports 80 and 443 are reachable");
    if (!allowedHost(host, this.options.hosts(desktop))) {
      if (desktop) this.options.refused?.(desktop, host);
      const why = `it is not on the desktop network allowlist${this.options.ask ? `; ${this.options.ask}` : " (Settings)"}`;
      // a client that sends its credential only when asked (git) is asked, for a host its desktop may reach
      return refuse(why, auth || known ? 403 : 407);
    }
    const mode = this.options.mode?.(desktop, host) ?? "tunnel";
    if (request && known) {
      const why = permitted(mode, method, target.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/");
      if (why) return refuse(why);
    }
    // a contained desktop's TLS to a host it may only read or upload to: terminated here, each request checked
    if (!request && known && this.options.ca && mode !== "tunnel" && port === 443 && !isIP(host)) {
      let inner: Socket;
      try { inner = await this.terminate(known, host, port); }
      catch { return answer(client, 502, `Could not reach ${host}:${port}.`); }
      if (client.destroyed) { inner.destroy(); return; }
      this.track(known, client, inner);
      inner.on("error", () => client.destroy());
      client.on("close", () => inner.destroy());
      inner.on("close", () => { if (!client.writableEnded) client.end(); });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) inner.write(rest);
      client.pipe(inner); inner.pipe(client);
      client.resume();
      return;
    }
    let upstream: Socket;
    try { upstream = await (this.options.dial ?? dialPublic)(host, port); }
    catch (e) { return e instanceof Refusal ? refuse(e.message) : answer(client, 502, `Could not reach ${host}:${port}.`); }
    if (client.destroyed) { upstream.destroy(); return; }
    if (desktop) this.track(desktop, client, upstream);
    upstream.on("error", () => { upstream.destroy(); client.destroy(); });
    client.on("close", () => upstream.destroy());
    // ended, not destroyed: what is still buffered for the client reaches it
    upstream.on("close", () => { if (!client.writableEnded) client.end(); });
    if (request) upstream.write(request); else client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (rest.length) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  }
}

function answer(client: Socket, status: number, text: string, headers: string[] = []): void {
  const reason = { 400: "Bad Request", 403: "Forbidden", 407: "Proxy Authentication Required", 431: "Request Header Fields Too Large", 502: "Bad Gateway" }[status] ?? "Error";
  const body = `${text}\n`;
  client.end([`HTTP/1.1 ${status} ${reason}`, ...headers, "Content-Type: text/plain", `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body].join("\r\n"));
}
