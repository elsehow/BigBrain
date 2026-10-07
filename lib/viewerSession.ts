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
 *   ?k=<secret>           the desktop shell's webview
 *   ?t=<expiry>&s=<mac>   `bigbrain open`: a link that works for two minutes,
 *                         so a browser's history keeps nothing usable
 * Either sets the cookie and redirects to `/` with the remaining query
 * parameters (the fragment rides along by itself), never the secret.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { configDir } from "./engine";
import { writeAtomic } from "./fsx";
import { json, send, THEME_SHEET } from "./httpx";

export const SESSION_PATH = "/api/session";
const LINK_TTL_MS = 120_000;
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Cookies are scoped to a host, not a port: the name carries the port, so
 * two engines on one machine keep separate sessions. */
const cookieName = (port: number): string => `bb_viewer_${port}`;

export const viewerSessionPath = (port: number, dir = configDir()): string => join(dir, `viewer-session-${port}`);

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
const linkMac = (secret: string, expiry: string): string => createHmac("sha256", secret).update(`viewer-link ${expiry}`).digest("base64url");

/** A browser's way in: `bigbrain open`'s link, good for two minutes. */
export function viewerLink(port: number, secret: string, now = Date.now()): string {
  const expiry = String(now + LINK_TTL_MS);
  return `http://127.0.0.1:${port}${SESSION_PATH}?t=${expiry}&s=${linkMac(secret, expiry)}`;
}

/** The header a native caller (a script, a probe) sends; empty when this
 * port has no session on disk. */
export function viewerAuthorization(port: number, dir?: string): Record<string, string> {
  const secret = readViewerSession(port, dir);
  return secret ? { authorization: `Bearer ${secret}` } : {};
}

function linkValid(secret: string, expiry: string | null, mac: string | null, now: number): boolean {
  if (!expiry || !mac || !/^\d{1,16}$/.test(expiry)) return false;
  const at = Number(expiry);
  return same(mac, linkMac(secret, expiry)) && at > now && at <= now + LINK_TTL_MS;
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BigBrain</title>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<p><b>Open BigBrain from the app.</b></p>
<p>In a browser on this machine, run <code>bigbrain open</code> for a link.</p>`;

function refuse(req: IncomingMessage, res: ServerResponse): false {
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
export function viewerGate(secret: string, port: number, now: () => number = Date.now): (req: IncomingMessage, res: ServerResponse) => boolean {
  const name = cookieName(port);
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    if (url.pathname === THEME_SHEET && (method === "GET" || method === "HEAD")) return true;
    if (url.pathname === SESSION_PATH && method === "GET") {
      const q = url.searchParams;
      const ok = q.has("k") ? same(q.get("k")!, secret) : linkValid(secret, q.get("t"), q.get("s"), now());
      if (!ok) return refuse(req, res);
      for (const key of ["k", "t", "s"]) q.delete(key);
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
