/**
 * httpx.ts — the node:http route kit the viewer and the first-run door
 * share (#639).
 *
 * Two servers in this repo answer on the web port: `web/server.ts` once a
 * vault exists, and `bin/desktop.ts`'s door before one does. Both were
 * `if` chains over `req.url`, and both had grown their own `readBody`,
 * their own JSON reply, and their own copy of the setup routes — with
 * subtly different answers, because nothing made them agree.
 *
 * This is the part that has no opinion about a vault, which is why it can
 * live here at all: the door runs BEFORE `BIGBRAIN_VAULT` names anything,
 * so anything it imports must not reach `lib/vaultRoot.ts`. Nothing in
 * this file imports anything but `node:http`.
 *
 * The third router, `lib/api.ts`, is deliberately not folded in: it speaks
 * `Request`/`Response`, not `IncomingMessage`/`ServerResponse`, and its
 * table carries auth scopes and rate limits that mean nothing on a
 * loopback viewer. Its dispatcher is the model this one follows.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Everything a route handler is given. `url` is parsed once per request,
 * so a handler reads `url.searchParams` rather than parsing again. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}

export interface Route {
  method: "GET" | "POST";
  /** An exact pathname, or a `/prefix/*` wildcard — `/assets/*` is the
   * only one either server needs. */
  path: string;
  handler: (ctx: Ctx) => void;
}

/**
 * The viewer's Content-Security-Policy — one string, both servers (#692).
 *
 * The note renderer sanitizes every `{@html}` body (DOMPurify), so this is
 * the second wall: a future `{@html}` that forgets sanitizeHtml(), or a
 * DOMPurify bypass, becomes a blocked console line instead of a script on
 * the origin that holds the whole vault behind unauthenticated loopback
 * routes. Scripts: this origin's bundle only — no inline, no eval. Styles
 * keep 'unsafe-inline' for now: the Svelte templates set a handful of
 * `style=` attributes and sanitized markdown may carry them, and CSS is
 * not code. The Google Fonts pair is the typeface tokens.css imports; a
 * self-hosted face retires it. `ipc:` / `http://ipc.localhost` is the Tauri IPC transport
 * (a fetch to a custom protocol from the page; Tauri falls back to
 * postMessage when it is blocked, with a warning) — the webview shows
 * this same page from this same server, so the header is the app's CSP
 * too: tauri.conf.json's `security.csp` only reaches pages Tauri serves
 * itself, and it serves none.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // web/ui/src/design/tokens.css @imports Hanken Grotesk from Google Fonts
  // — the one third-party origin the viewer touches. Self-hosting the face
  // (#488's "what leaves the box") is what removes these two hosts.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self' blob:",
  // the pilot (#770) offers its WebRTC call to OpenAI from the page — the
  // one fetch that leaves the origin, authenticated with a client secret the
  // engine minted (lib/pilot.ts), never the key. The media itself is
  // WebRTC, which CSP does not govern.
  "connect-src 'self' ipc: http://ipc.localhost https://api.openai.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** The headers every response carries, set before any route runs so a
 * 404, a 500 and a streamed file all get them: node merges what setHeader
 * put here into the object a later writeHead passes. `nosniff` globally —
 * lib/staticServe.ts sets it per file too, which is fine twice. */
export function armor(res: ServerResponse): void {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

/** The unauthenticated viewer and setup door trust local programs, not arbitrary
 * websites. Loopback binding alone does not prevent DNS rebinding or browser
 * writes. Apply this before ALL routes, including reads and first-run setup.
 * No forwarded header grants access. A local dev proxy may preserve its own
 * loopback Host and Origin; the TCP listener's port need not equal that Host. */
export function allowLoopbackRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const refuse = (status: number, error: string): false => {
    json(res, status, { error });
    return false;
  };
  const host = req.headers.host;
  const match = typeof host === "string" && /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)))
    return refuse(403, "Use a loopback address to access the app.");

  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return refuse(403, "The app's own origin is required.");
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const expected = new URL(`http://${host}`).origin;
      if (typeof origin !== "string" || origin !== new URL(origin).origin || origin !== expected)
        return refuse(403, "The app's own origin is required.");
    } catch {
      return refuse(403, "The app's own origin is required.");
    }
  }
  // Simple HTML forms and no-cors fetches can send text/plain without a
  // preflight. Native callers may omit Origin, but must still use JSON.
  if (!["GET", "HEAD", "OPTIONS"].includes((req.method ?? "GET").toUpperCase())) {
    const type = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (type !== "application/json") return refuse(415, "Use application/json for app requests.");
  }
  return true;
}

/** Reply with a body already serialized. API responses are live vault
 * state, so nothing here may be cached. */
export function send(res: ServerResponse, code: number, body: string, type = "application/json"): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/** Reply with JSON. */
export function json(res: ServerResponse, code: number, value: unknown): void {
  send(res, code, JSON.stringify(value));
}

/** Collect a request body, capped. Over the cap the promise rejects AND
 * the socket is destroyed — a caller that has already stopped reading must
 * not keep paying for an upload it refused. `Infinity` is a deliberate
 * choice at one call site (attachments ride /api/drop as base64 into
 * add-only disk, not into git history); the item text stays capped inside
 * lib/intake.ts. */
export function readBody(req: IncomingMessage, cap = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Does this table entry answer this request? Exported for the route
 * inventory test; dispatch is what callers use. */
export function routeMatches(route: Route, method: string, path: string): boolean {
  if (route.method !== method) return false;
  return route.path.endsWith("/*")
    ? path.startsWith(route.path.slice(0, -1))
    : path === route.path;
}

/** Run the first matching route, or return false so the caller can answer
 * its own 404 — the two servers word that differently, and the door's
 * "no vault yet" is the more useful of the two where it applies.
 *
 * The URL is parsed against a fixed loopback base because only `pathname`
 * and `searchParams` are ever read: the real port would be a parameter
 * that changes nothing. */
export function dispatch(routes: readonly Route[], req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = (req.method ?? "GET").toUpperCase();
  for (const route of routes) {
    if (!routeMatches(route, method, url.pathname)) continue;
    route.handler({ req, res, url });
    return true;
  }
  return false;
}
