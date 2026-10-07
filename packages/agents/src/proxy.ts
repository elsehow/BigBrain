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
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, connect, createServer, isIP, type Server, type Socket } from "node:net";

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

const dialed = (s: Socket) => new Promise<Socket>((done, fail) => { s.once("connect", () => done(s)); s.once("error", fail); });

class Refusal extends Error {}

export interface EgressOptions {
  /** Hosts commands may reach, asked per connection: `desktop` when its credential says whose it is. */
  hosts: (desktop?: string) => Iterable<string>;
  /** How to ask for a host off the list, said when one is refused. */
  ask?: string;
  /** How an allowed connection is made; tests stand in a local upstream. */
  dial?: (host: string, port: number) => Promise<Socket>;
}

export class EgressProxy {
  private server?: Server;
  private listening?: Promise<number>;
  private key = randomBytes(32);
  constructor(private options: EgressOptions) {}

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

  close(): void { this.server?.close(); this.server = undefined; this.listening = undefined; }

  private serve(client: Socket): void {
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
      this.forward(client, head.subarray(0, end).toString("latin1").split("\r\n"), head.subarray(end + 4)).catch(() => client.destroy());
    };
    client.on("data", take);
  }

  private async forward(client: Socket, lines: string[], rest: Buffer): Promise<void> {
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
    const desktop = this.desktopOf(auth?.slice(auth.indexOf(":") + 1));
    const refuse = (why: string, status = 403) => answer(client, status, `BigBrain's sandbox refused ${host}:${port}: ${why}.`,
      status === 407 ? ['Proxy-Authenticate: Basic realm="BigBrain"'] : []);
    if (!PORTS.has(port)) return refuse("only ports 80 and 443 are reachable");
    if (!allowedHost(host, this.options.hosts(desktop))) {
      const why = `it is not on the desktop network allowlist${this.options.ask ? `; ${this.options.ask}` : " (Settings)"}`;
      // a client that sends its credential only when asked (git) is asked, for a host its desktop may reach
      return refuse(why, auth ? 403 : 407);
    }
    let upstream: Socket;
    try { upstream = await (this.options.dial ?? dialPublic)(host, port); }
    catch (e) { return e instanceof Refusal ? refuse(e.message) : answer(client, 502, `Could not reach ${host}:${port}.`); }
    if (client.destroyed) { upstream.destroy(); return; }
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
