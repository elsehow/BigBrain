/**
 * remoteContent.ts — `/api/remote-image?url=`: a source's own images, fetched
 * by the engine so the app's CSP can keep `img-src 'self'`; and
 * `/api/remote-page?url=`: a saved source's page as text, for the source
 * view's reader (Readability, in the browser) when the page itself reads
 * better than what was saved of it.
 *
 * Only public http(s) addresses (never this machine or the local network,
 * checked on every redirect, and the connection made to the address that
 * was checked), only raster image types, and a size cap. The
 * response carries no cookies or referrer; the image's host still sees the
 * request, as it would from a browser.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Route } from "./httpx";

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;

/** An IPv4 address that isn't on the public internet: this network,
 * private, CGNAT, loopback, link-local, IETF/documentation/benchmarking,
 * the 6to4 relay, multicast, reserved and broadcast. */
function privateV4([a = 0, b = 0, c = 0]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** An IPv6 literal's eight 16-bit words (a trailing dotted IPv4 included); null when it isn't one. */
function v6Words(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let s = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    s = s.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const part = (x: string | undefined) => (x ? x.split(":").map(w => parseInt(w, 16)) : []);
  const h = part(head), t = part(tail);
  return tail === undefined ? h : [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/** Not a public address: anything that isn't plainly an IP, a private IPv4,
 * and for IPv6 anything outside global unicast. IPv6 forms that carry an
 * IPv4 address (mapped, compatible, NAT64, 6to4) are judged by that address;
 * Teredo and the documentation prefixes are refused outright. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip.split(".").map(Number));
  const w = v6Words(ip.replace(/%.*$/, ""));
  if (!w || w.length !== 8) return true;
  const v4 = (i: number) => [w[i]! >> 8, w[i]! & 255, w[i + 1]! >> 8, w[i + 1]! & 255];
  if (w.slice(0, 5).every(x => x === 0) && (w[5] === 0 || w[5] === 0xffff)) return privateV4(v4(6));
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every(x => x === 0)) return privateV4(v4(6));
  if (w[0] === 0x2002) return privateV4(v4(1));
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true;
  return (w[0]! & 0xe000) !== 0x2000 || (w[0] === 0x3fff && w[1]! < 0x1000);
}

type Lookup = (host: string) => Promise<string[]>;
const resolve: Lookup = host => lookup(host, { all: true }).then(r => r.map(a => a.address), () => []);

/** A URL the engine may fetch, with the addresses it may connect to for it:
 * http(s), and every address its host names is public. */
export async function publicUrl(raw: string, dns: Lookup = resolve): Promise<{ url: URL; addrs: string[] } | null> {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  const addrs = isIP(host) ? [host] : await dns(host);
  return addrs.length && !addrs.some(privateAddress) ? { url, addrs: addrs.sort((a, b) => isIP(a) - isIP(b)) } : null;
}

/** GET one hop on an address publicUrl checked — the URL's own host rides in
 * Host and SNI, and the certificate is checked against it — so a name can't
 * answer public to the check and private to the connection. */
async function pinned({ url, addrs }: { url: URL; addrs: string[] }, accept: string, get: typeof fetch): Promise<Response> {
  const init = { redirect: "manual" as const, signal: AbortSignal.timeout(15_000),
    headers: { accept, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" } };
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return get(url, init);
  let failed: unknown;
  for (const ip of addrs) {
    const at = new URL(url);
    at.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
    try { return await get(at, { ...init, headers: { ...init.headers, host: url.host }, tls: { serverName: url.hostname } }); }
    catch (e) { failed = e; }
  }
  throw failed;
}

/** GET a public URL, re-checking every redirect; null when it can't be reached. */
export async function fetchPublic(raw: string, accept: string, net: { dns?: Lookup; get?: typeof fetch } = {}): Promise<{ r: Response; at: URL } | null> {
  let target = await publicUrl(raw, net.dns);
  for (let hop = 0; target && hop < 5; hop++) {
    const r = await pinned(target, accept, net.get ?? fetch);
    const next = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!next) return { r, at: target.url };
    target = await publicUrl(new URL(next, target.url).href, net.dns);
  }
  return null;
}

const MAX_PAGE = 5 * 1024 * 1024;

/** `allowed`: the vault's security.remote_content, read per request so the setting takes at once. */
export function remoteContentRoutes(allowed: () => boolean): Route[] {
  const fail = (res: import("node:http").ServerResponse, status: number) => { res.writeHead(status, { "content-type": "text/plain" }); res.end(); };
  return [{ method: "GET", path: "/api/remote-image", handler: async ({ res, url }) => {
    if (!allowed()) return fail(res, 403);
    try {
      const got = await fetchPublic(url.searchParams.get("url") ?? "", "image/*");
      const type = got?.r.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!got || !got.r.ok || !TYPES.test(type) || Number(got.r.headers.get("content-length") ?? 0) > MAX_BYTES) return fail(res, 404);
      const bytes = new Uint8Array(await got.r.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) return fail(res, 404);
      res.writeHead(200, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400" });
      res.end(bytes);
    } catch { fail(res, 502); }
  } }, { method: "GET", path: "/api/remote-page", handler: async ({ res, url }) => {
    if (!allowed()) return fail(res, 403);
    try {
      const got = await fetchPublic(url.searchParams.get("url") ?? "", "text/html");
      const type = got?.r.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!got || !got.r.ok || !/^(text\/html|application\/xhtml\+xml)$/i.test(type)) return fail(res, 404);
      const text = await got.r.text();
      if (text.length > MAX_PAGE) return fail(res, 404);
      // text/plain: the page is data for the reader, never rendered as this origin
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "x-final-url": got.at.href, "cache-control": "private, max-age=3600" });
      res.end(text);
    } catch { fail(res, 502); }
  } }];
}
