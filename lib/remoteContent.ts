/**
 * remoteContent.ts — `/api/remote-image?url=`: a source's own images, fetched
 * by the engine so the app's CSP can keep `img-src 'self'`; and
 * `/api/remote-page?url=`: a saved source's page as text, for the source
 * view's reader (Readability, in the browser) when the page itself reads
 * better than what was saved of it.
 *
 * Only public http(s) addresses (never this machine or the local network,
 * checked on every redirect), only raster image types, and a size cap. The
 * response carries no cookies or referrer; the image's host still sees the
 * request, as it would from a browser.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Route } from "./httpx";

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** A URL the engine may fetch: http(s), and every address it names is public. */
export async function publicUrl(raw: string): Promise<URL | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  const addrs = isIP(host) ? [host] : await lookup(host, { all: true }).then(r => r.map(a => a.address), () => []);
  return addrs.length && !addrs.some(privateAddress) ? u : null;
}

/** GET a public URL, re-checking every redirect; null when it can't be reached. */
async function fetchPublic(raw: string, accept: string): Promise<{ r: Response; at: URL } | null> {
  let target = await publicUrl(raw);
  for (let hop = 0; target && hop < 5; hop++) {
    const r = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { accept, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" } });
    const next = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!next) return { r, at: target };
    target = await publicUrl(new URL(next, target).href);
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
