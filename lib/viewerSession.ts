/**
 * viewerSession.ts — the viewer's per-launch session: web/server.ts, and the
 * first-run door that answers on the same port before a vault exists.
 *
 * allowLoopbackRequest (lib/httpx.ts) keeps websites out. This keeps out the
 * local programs that are not the person: every route needs this launch's
 * secret, as the cookie a browser is given by the bootstrap link, or as
 * `Authorization: Bearer` from a native caller that can read the file.
 *
 * One file per web port, `~/.config/bigbrain/viewer-session-<port>`: 0600,
 * in the owner-only config dir that desktops and Pilot are denied. Under the
 * app the supervisor writes it at each start, before the door or the viewer
 * binds, and the viewer reads it there at startup — the secret is never in
 * argv or the environment, and survives the viewer's restarts, a vault
 * switch, and the door handing over to the engine. Run by hand, the viewer
 * makes its own. Readers: the desktop shell (its /api/engine probe, and the
 * window's bootstrap), `bigbrain open`.
 *
 * The bootstrap, `GET /api/session` (under /api, so the dev loop's vite
 * proxies it too):
 *   ?k=<secret>                the desktop shell's webview
 *   ?t=<expiry>&n=<nonce>&s=<mac>
 *                              `bigbrain open`: a link that works once, within
 *                              a minute — so neither a browser's history nor
 *                              the opener's argument list keeps anything usable
 * Either sets the cookie and redirects to `/` with the remaining query
 * parameters (the fragment rides along by itself), never the secret.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { configDir } from "./engine";
import { writeAtomic } from "./fsx";
import { json, send, THEME_SHEET } from "./httpx";

export const SESSION_PATH = "/api/session";
const LINK_TTL_MS = 60_000;
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Cookies are scoped to a host, not a port: the name carries the port, so
 * two engines on one machine keep separate sessions. */
const cookieName = (port: number): string => `bb_viewer_${port}`;

export const viewerSessionPath = (port: number, dir = configDir()): string => join(dir, `viewer-session-${port}`);

/** One empty file per unspent link, `<port>-<expiry>-<nonce>`: redeeming one
 * deletes it, which only one request can do — the door, the viewer and a
 * restarted viewer all see the same answer. */
const linkPath = (dir: string, port: number, expiry: string, nonce: string): string => join(dir, "viewer-links", `${port}-${expiry}-${nonce}`);

export const newViewerSecret = (): string => randomBytes(32).toString("base64url");

export function writeViewerSession(port: number, secret: string): void {
  writeAtomic(viewerSessionPath(port), secret, 0o600);
}

/** A new secret for this launch, on disk before anything binds the port. */
export function createViewerSession(port: number): string {
  const secret = newViewerSecret();
  writeViewerSession(port, secret);
  return secret;
}

export function readViewerSession(port: number, dir?: string): string | null {
  try {
    const secret = readFileSync(viewerSessionPath(port, dir), "utf8").trim();
    return SHAPE.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
/** Constant time whatever the lengths: both sides are hashed first. No
 * secret matches nothing. */
const same = (given: string, secret: string): boolean => timingSafeEqual(digest(given), digest(secret)) && secret !== "";
const linkMac = (secret: string, expiry: string, nonce: string): string =>
  createHmac("sha256", secret).update(`viewer-link ${expiry} ${nonce}`).digest("base64url");

/** A browser's way in: `bigbrain open`'s link, good once, within a minute.
 * Links nobody redeemed are cleared as the next one is made. */
export function viewerLink(port: number, secret: string, now = Date.now(), dir = configDir()): string {
  const expiry = String(now + LINK_TTL_MS), nonce = randomBytes(16).toString("base64url");
  try {
    for (const f of readdirSync(join(dir, "viewer-links"))) if (Number(f.split("-")[1]) < now) rmSync(join(dir, "viewer-links", f), { force: true });
  } catch { /* none yet */ }
  writeAtomic(linkPath(dir, port, expiry, nonce), "", 0o600);
  return `http://127.0.0.1:${port}${SESSION_PATH}?t=${expiry}&n=${nonce}&s=${linkMac(secret, expiry, nonce)}`;
}

/** The secret of the viewer answering on `port`, once it answers with it —
 * for a launcher that starts one and opens a browser on it. A file left by
 * an earlier run on the same port does not count. */
export async function viewerReady(port: number, dir?: string, tries = 100): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const secret = readViewerSession(port, dir);
    try {
      if (secret && (await fetch(`http://127.0.0.1:${port}/api/engine`, { headers: { authorization: `Bearer ${secret}` } })).ok) return secret;
    } catch { /* not listening yet */ }
    await Bun.sleep(100);
  }
  return null;
}

/** The header a native caller (a script, a probe) sends; empty when this
 * port has no session on disk. */
export function viewerAuthorization(port: number, dir?: string): Record<string, string> {
  const secret = readViewerSession(port, dir);
  return secret ? { authorization: `Bearer ${secret}` } : {};
}

function redeemLink(secret: string, q: URLSearchParams, port: number, now: number, dir: string): boolean {
  const expiry = q.get("t"), nonce = q.get("n"), mac = q.get("s");
  if (!expiry || !nonce || !mac || !/^\d{1,16}$/.test(expiry) || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) return false;
  const at = Number(expiry);
  if (!same(mac, linkMac(secret, expiry, nonce)) || at <= now || at > now + LINK_TTL_MS) return false;
  try {
    unlinkSync(linkPath(dir, port, expiry, nonce));
    return true;
  } catch {
    return false; // spent, or never made here
  }
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BigBrain</title>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<p><b>Open BigBrain from the app.</b></p>
<p>In a browser on this machine, run <code>bigbrain open</code> for a link.</p>`;

function refuse(req: IncomingMessage, res: ServerResponse): false {
  res.setHeader("www-authenticate", 'Bearer realm="BigBrain viewer"');
  const page = req.method === "GET" && (req.headers["sec-fetch-dest"] === "document" || /text\/html/.test(req.headers.accept ?? ""));
  if (page) send(res, 401, PAGE, "text/html; charset=utf-8");
  else json(res, 401, { error: "This needs BigBrain's session: open it from the app, or run `bigbrain open`." });
  return false;
}

/**
 * The gate, in front of every route after allowLoopbackRequest: true when
 * the request may go on, else it has been answered. Public, in full: the
 * bootstrap, and the theme sheet that agents' pages on other loopback ports
 * link (colours and fonts; those pages carry no session).
 */
export function viewerGate(secret: string, port: number, now: () => number = Date.now, dir = configDir()): (req: IncomingMessage, res: ServerResponse) => boolean {
  const name = cookieName(port);
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    if (url.pathname === THEME_SHEET && (method === "GET" || method === "HEAD")) return true;
    if (url.pathname === SESSION_PATH && method === "GET") {
      const q = url.searchParams;
      const ok = q.has("k") ? same(q.get("k")!, secret) : redeemLink(secret, q, port, now(), dir);
      if (!ok) return refuse(req, res);
      for (const key of ["k", "t", "n", "s"]) q.delete(key);
      const rest = q.toString();
      res.writeHead(303, {
        location: rest ? `/?${rest}` : "/",
        "set-cookie": `${name}=${secret}; HttpOnly; SameSite=Strict; Path=/`,
        "cache-control": "no-store",
      });
      res.end();
      return false;
    }
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const cookie = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
    const given = bearer ?? cookie;
    return given !== undefined && same(given, secret) ? true : refuse(req, res);
  };
}
