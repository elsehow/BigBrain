/**
 * sharedOAuth.ts — the shared door's Claude connector: a small OAuth 2.1
 * authorization server in front of `/mcp` (lib/sharedMcp.ts), so a member
 * can add a shared vault to Claude by pasting `https://<host>/mcp` into
 * Settings → Connectors (docs/shared-vault-connector.md).
 *
 * Claude's custom connectors cannot carry a pasted bearer secret; they speak
 * OAuth. This module is the least OAuth that satisfies them:
 *
 *   discovery   RFC 9728 protected-resource metadata and RFC 8414
 *               authorization-server metadata, both derived from the ONE
 *               configured public URL — never from a Host header.
 *   register    RFC 7591 dynamic client registration, public clients only,
 *               redirect URIs from a fixed allowlist: Claude's two hosted
 *               callbacks exactly, and the loopback `/callback` Claude Code
 *               uses, matched without its port at /authorize.
 *   authorize   the member signs in — with Google when the operator
 *               configured it, or by pasting an invite link — and then
 *               APPROVES on a consent page that names who they are signed
 *               in as. Consent is never skipped.
 *   token       authorization_code + PKCE S256 for a NEW `sv_` agent
 *               credential with exactly `read` (lib/sharedMembers.ts). It is
 *               an ordinary credential: verified on every request, cut by
 *               revoking the member or the credential, no expiry, no
 *               refresh token. The connector reads; contributing stays in
 *               the BigBrain app.
 *
 * Google is the LOGIN, not the authorization server: an OIDC code flow with
 * `state` and `nonce` whose id_token arrives straight from Google's token
 * endpoint over TLS, so its signature is not re-verified — but its `iss`,
 * `aud`, `exp`, `nonce` and `email_verified` are. The verified account is
 * matched to a member by `lib/sharedMembers.ts` bindMemberIdentity.
 *
 * What lives where:
 *   - registered clients: a 0600 sidecar beside the member store
 *     (`<store>.oauth-clients.json`), bounded — Claude registers a fresh
 *     client on every new connection, and a client is only needed between
 *     /authorize and /token, so the least recently used is evicted first;
 *   - pending authorizations (≤10 min) and codes (≤60 s, single use):
 *     memory. A restart drops logins in flight, which is acceptable.
 *
 * A pending authorization is bound to the browser that started it by an
 * HttpOnly, SameSite=Lax cookie (`__Host-` prefixed and Secure on https),
 * checked on the Google callback, the invite POST and the consent POST;
 * the two POSTs also carry a per-authorization CSRF token. Without that, a
 * stranger could start an authorization in their own Claude and hand a
 * member the sign-in link.
 *
 * Nothing secret is logged: the door logs pathnames only, and this module
 * logs refusal reasons, never a code, token, invite secret, or email.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "./fsx";
import { sharedVaultIdentity, identifyBySharedInvite } from "./sharedInvites";
import { SharedMemberBusyError } from "./sharedMemberLock";
import { bindMemberIdentity, listMembers, mintCredential, revokeCredential, SharedMemberError, type SharedMember } from "./sharedMembers";

export interface SharedConnectorConfig {
  /** The door's public origin, e.g. `https://vault.example.com`. */
  publicUrl: string;
  /** "Sign in with Google"; absent, the invite link is the only login. */
  google?: { clientId: string; clientSecret: string };
}

export interface SharedConnectorDeps {
  config: SharedConnectorConfig;
  root: string;
  storePath: string;
  now: () => Date;
  log: (line: string) => void;
  /** Outbound HTTP (Google's token endpoint) — injectable so tests use a fake Google. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface SharedConnector {
  /** `<public>/mcp` — the URL a member pastes into Claude. */
  resourceUrl: string;
  /** A public connector route's answer, or undefined when `url` is not one. */
  handlePublic(req: Request, url: URL): Promise<Response | undefined>;
  /** The 401 that starts Claude's sign-in. */
  unauthorized(): Response;
}

export const MCP_PATH = "/mcp";
export const HOSTED_CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"] as const;

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
/** How long a burned code is remembered, so a replay can be recognised and
 * the credential it bought revoked (RFC 6749 §4.1.2). */
const CODE_MEMORY_MS = 10 * 60_000;
const MAX_PENDING = 500;
const MAX_CLIENTS = 1000;
const CLIENT_IDLE_MS = 30 * 24 * 3600_000;
/** Every public POST body is a handful of short fields. */
export const MAX_PUBLIC_BODY_BYTES = 16 * 1024;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_TIMEOUT_MS = 8_000;

/** Validate the operator's public URL and reduce it to an origin. Must be
 * https — or http on loopback, for development and tests — and name no
 * path: discovery lives at the origin's `/.well-known/`. */
export function parsePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`public URL "${raw}" is not a URL — use https://vault.example.com`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(`public URL must be https (http only on loopback), got ${url.protocol}//${url.host}`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Error(`public URL must be a bare origin like https://vault.example.com, got ${raw}`);
  return url.origin;
}

// ── small HTTP helpers ──────────────────────────────────────────────────────

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...headers },
  });

/** An RFC 6749 §5.2 / RFC 7591 §3.2.2 error body. */
const oauthError = (status: number, error: string, description: string, headers: Record<string, string> = {}): Response =>
  json(status, { error, error_description: description }, headers);

const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { Location: location, ...BASE_HEADERS } });

/** The body as text, or null when it exceeds `max` — refused on the
 * declared length before reading, and on the bytes actually read. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A form body's fields — or a reason it is unusable. RFC 6749 §3.1: a
 * parameter sent twice is an invalid request, not a choice. */
async function formBody(req: Request): Promise<URLSearchParams | string> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
    return "send application/x-www-form-urlencoded";
  const raw = await readCapped(req, MAX_PUBLIC_BODY_BYTES);
  if (raw === null) return `the body exceeds ${MAX_PUBLIC_BODY_BYTES} bytes`;
  const form = new URLSearchParams(raw);
  for (const key of new Set(form.keys())) if (form.getAll(key).length > 1) return `parameter ${key} sent more than once`;
  return form;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const random = (bytes = 32): string => randomBytes(bytes).toString("base64url");

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a), "hex");
  const y = Buffer.from(sha256(b), "hex");
  return timingSafeEqual(x, y);
}

/** One line of untrusted display text: control characters out, collapsed,
 * capped. Escaping for HTML is separate (esc). */
const oneLine = (raw: string, max: number): string =>
  raw.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);

/** A fixed token bucket. The door sits behind a TLS proxy and has no client
 * address it can trust, so the buckets are per endpoint, not per caller. */
class Bucket {
  private tokens: number;
  private last: number;
  constructor(private readonly perMinute: number, now: number) {
    this.tokens = perMinute;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) * this.perMinute) / 60_000);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ── redirect URIs ───────────────────────────────────────────────────────────

/** `http://localhost[:port]/callback` or `http://127.0.0.1[:port]/callback`,
 * written canonically (no query, fragment, userinfo, or odd encoding) — the
 * loopback redirect a native client like Claude Code uses (RFC 8252 §7.3). */
function loopbackHost(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) return null;
  const canonical = `http://${url.hostname}${url.port ? `:${url.port}` : ""}/callback`;
  return uri === canonical ? url.hostname : null;
}

/** May a client register this redirect URI at all? */
export function allowedRedirectUri(uri: string): boolean {
  return (HOSTED_CALLBACKS as readonly string[]).includes(uri) || loopbackHost(uri) !== null;
}

/** Does `requested` match one of a client's registered URIs? Exactly — except
 * that a loopback URI matches a registered loopback URI on the same host
 * with any port, because the native client's port changes per session. */
function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (!allowedRedirectUri(requested)) return false;
  if (registered.includes(requested)) return true;
  const host = loopbackHost(requested);
  return host !== null && registered.some((r) => loopbackHost(r) === host);
}

// ── the client registry (a sidecar beside the member store) ────────────────

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created: string;
  last_used: string;
}

export const clientsPath = (storePath: string): string => `${storePath}.oauth-clients.json`;

class ClientRegistry {
  constructor(private readonly path: string, private readonly now: () => Date) {}

  private read(): RegisteredClient[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { version?: number; clients?: RegisteredClient[] };
      return raw.version === 1 && Array.isArray(raw.clients) ? raw.clients : [];
    } catch {
      return [];
    }
  }

  private write(clients: RegisteredClient[]): void {
    writeAtomic(this.path, `${JSON.stringify({ version: 1, clients }, null, 2)}\n`, 0o600);
  }

  get(id: string | null): RegisteredClient | undefined {
    return id ? this.read().find((c) => c.client_id === id) : undefined;
  }

  /** Register, first pruning clients idle for 30 days and then, at the cap,
   * evicting the least recently used. An evicted client loses nothing it
   * has already obtained: its token is a credential, not a client session. */
  register(name: string, redirectUris: string[]): RegisteredClient {
    const now = this.now();
    const clients = this.read()
      .filter((c) => now.getTime() - Date.parse(c.last_used) < CLIENT_IDLE_MS)
      .sort((a, b) => a.last_used.localeCompare(b.last_used));
    while (clients.length >= MAX_CLIENTS) clients.shift();
    const client: RegisteredClient = {
      client_id: `bbc_${random(16)}`,
      client_name: name,
      redirect_uris: redirectUris,
      created: now.toISOString(),
      last_used: now.toISOString(),
    };
    clients.push(client);
    this.write(clients);
    return client;
  }

  touch(id: string): void {
    const clients = this.read();
    const client = clients.find((c) => c.client_id === id);
    if (!client) return;
    client.last_used = this.now().toISOString();
    this.write(clients);
  }
}

// ── pages ───────────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The app's own type and ink (web/ui/src/design/tokens.css), no web font
// fetched: the CSP allows nothing to load.
const STYLE = `
body{margin:0;background:#fff;color:#211A18;font:400 15px/1.5 "Hanken Grotesk",system-ui,-apple-system,sans-serif}
main{max-width:30rem;margin:12vh auto;padding:0 22px}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;opacity:.6;margin:0 0 8px}
h1{font-size:24px;font-weight:500;letter-spacing:-.022em;line-height:1.2;margin:0 0 16px}
p,ul{margin:0 0 16px}
.meta{font-size:12px;opacity:.65}
.notice{border-left:3px solid #CC4A3E;padding:6px 13px}
form{margin:0 0 16px}
label{display:block;font-weight:500;margin:0 0 6px}
input[type=password]{box-sizing:border-box;width:100%;font:inherit;padding:8px 13px;border:1px solid #d8d3d1;border-radius:5px;margin:0 0 8px}
.button,button{display:inline-block;font:500 15px/1 "Hanken Grotesk",system-ui,-apple-system,sans-serif;padding:11px 16px;border-radius:11px;border:1px solid #211A18;background:#211A18;color:#fff;text-decoration:none;cursor:pointer;margin:0 8px 8px 0}
button.secondary{background:#fff;color:#211A18}
`;
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

// No `form-action`: Chrome applies it to the redirect that FOLLOWS a form
// POST, and the consent POST's redirect goes to the client's redirect URI.
// Every form here posts to a fixed path of this origin, built from escaped
// values, so the directive would add breakage and no protection.
const PAGE_HEADERS = {
  ...BASE_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; frame-ancestors 'none'`,
};

function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

const START_AGAIN = "Start again from Claude: open the connector in Claude's settings and choose Connect.";

// ── state held in memory ────────────────────────────────────────────────────

interface Pending {
  id: string;
  csrf: string;
  /** sha256 of the browser cookie that started this authorization. */
  browser: string;
  expires: number;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  google?: { state: string; nonce: string };
  member?: { id: string; display: string; handle: string; signedInAs: string };
}

interface CodeRecord {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  memberId: string;
  handle: string;
  expires: number;
  used: boolean;
  /** The credential the code bought, revoked if the code is replayed. */
  credentialId?: string;
}

// ── the connector ──────────────────────────────────────────────────────────

export function makeSharedConnector(deps: SharedConnectorDeps): SharedConnector {
  const origin = parsePublicUrl(deps.config.publicUrl);
  const resourceUrl = `${origin}${MCP_PATH}`;
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  const googleCallback = `${origin}/oauth/google/callback`;
  const secure = origin.startsWith("https:");
  // `__Host-` refuses a cookie set by a sibling subdomain (cookie tossing),
  // but requires Secure — so plain-http loopback uses an unprefixed name.
  const cookieName = secure ? "__Host-bb_oauth" : "bb_oauth";
  const google = deps.config.google;
  const fetchImpl = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const clients = new ClientRegistry(clientsPath(deps.storePath), deps.now);
  const pending = new Map<string, Pending>();
  const codes = new Map<string, CodeRecord>();
  const t0 = deps.now().getTime();
  const buckets = { register: new Bucket(20, t0), token: new Bucket(60, t0), pages: new Bucket(120, t0) };

  const now = (): number => deps.now().getTime();
  const vaultName = (): string => sharedVaultIdentity(deps.root).name;
  const warn = (event: string, extra: Record<string, unknown> = {}): void =>
    deps.log(JSON.stringify({ ts: deps.now().toISOString(), warn: `connector: ${event}`, ...extra }));
  const limited = (bucket: Bucket): boolean => !bucket.take(now());

  function prune(): void {
    const t = now();
    for (const [id, p] of pending) if (p.expires <= t) pending.delete(id);
    for (const [hash, c] of codes) if (c.expires + CODE_MEMORY_MS <= t) codes.delete(hash);
  }

  // ── the browser binding ──

  function cookieOf(req: Request): string | null {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === cookieName) {
        const value = rest.join("=");
        return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
      }
    }
    return null;
  }

  const setCookie = (value: string): string =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PENDING_TTL_MS / 1000}${secure ? "; Secure" : ""}`;

  /** The pending authorization `id` names, if THIS browser started it and
   * (for the POSTs) the form carries its CSRF token. */
  function bound(req: Request, id: string | null, csrf?: string | null): Pending | undefined {
    prune();
    const p = id ? pending.get(id) : undefined;
    const cookie = cookieOf(req);
    if (!p || !cookie || !sameSecret(sha256(cookie), p.browser)) return undefined;
    if (csrf !== undefined && (!csrf || !sameSecret(csrf, p.csrf))) return undefined;
    return p;
  }

  const expiredPage = (): Response =>
    page(400, "Sign-in expired", `<h1>This sign-in has expired</h1><p>It may have timed out, or been started in a different browser.</p><p>${esc(START_AGAIN)}</p>`);

  // ── the pages ──

  function hostOf(uri: string): string {
    const url = new URL(uri);
    return url.host;
  }

  function authorizePage(p: Pending, notice?: string, status = 200): Response {
    const loopback = loopbackHost(p.redirectUri) !== null;
    const body = `
<p class="eyebrow">BigBrain shared vault</p>
<h1>${esc(vaultName())}</h1>
${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
<p><strong>${esc(p.clientName)}</strong> is asking for <strong>read-only</strong> access to this vault. Afterwards you will return to <strong>${esc(hostOf(p.redirectUri))}</strong>.</p>
${loopback ? `<p class="notice">That is an app on your own computer. Continue only if you just started this from Claude Code or another app you trust.</p>` : ""}
<p>Sign in as a member of this vault.</p>
${google ? `<p><a class="button" href="/oauth/google?pending=${esc(encodeURIComponent(p.id))}">Sign in with Google</a></p>` : ""}
<form method="post" action="/authorize/invite">
<input type="hidden" name="pending" value="${esc(p.id)}"><input type="hidden" name="csrf" value="${esc(p.csrf)}">
<label for="invite">${google ? "Or paste" : "Paste"} an invite link from the vault's owner</label>
<input id="invite" name="invite" type="password" autocomplete="off" required>
<button type="submit" class="${google ? "secondary" : ""}">Continue with invite link</button>
</form>
<p class="meta">An invite link works once: using it here means it can no longer connect the BigBrain app. This connection can only read; contributing happens in the BigBrain app.</p>`;
    return page(status, `Connect ${vaultName()}`, body);
  }

  function consentPage(p: Pending): Response {
    const m = p.member!;
    const body = `
<p class="eyebrow">BigBrain shared vault</p>
<h1>Allow ${esc(p.clientName)} to read ${esc(vaultName())}?</h1>
<p>Signed in as <strong>${esc(m.display)}</strong> (${esc(m.signedInAs)}).</p>
<ul><li>It can read this vault's evidence, claims and change feed, as you.</li><li>It cannot add, change or withdraw anything.</li><li>You will return to <strong>${esc(hostOf(p.redirectUri))}</strong>.</li></ul>
<form method="post" action="/authorize/consent">
<input type="hidden" name="pending" value="${esc(p.id)}"><input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button type="submit" name="decision" value="approve">Allow read-only access</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>
<p class="meta">The vault's owner can revoke this access at any time.</p>`;
    return page(200, `Allow access to ${vaultName()}`, body);
  }

  const refusalPage = (status: number, title: string, message: string): Response =>
    page(status, title, `<p class="eyebrow">BigBrain shared vault</p><h1>${esc(title)}</h1><p>${esc(message)}</p>`);

  /** The live member who may grant read, or why not. */
  function readableMember(id: string): SharedMember | "gone" | "no-read" {
    const m = listMembers(deps.storePath).find((one) => one.id === id && !one.revoked);
    if (!m) return "gone";
    return m.permissions.includes("read") ? m : "no-read";
  }

  /** After either login: record who signed in and show consent. */
  function signedIn(p: Pending, member: SharedMember, signedInAs: string): Response {
    const ok = readableMember(member.id);
    if (ok === "gone") return refusalPage(403, "Not a member", "You're not a member of this vault. Ask its owner to add you.");
    if (ok === "no-read") return refusalPage(403, "No read access", "Your membership doesn't include read access. Ask the vault's owner.");
    p.member = { id: member.id, display: member.display, handle: member.handle, signedInAs };
    return consentPage(p);
  }

  // ── discovery ──

  const protectedResource = (): Response =>
    json(200, { resource: resourceUrl, authorization_servers: [origin], scopes_supported: ["read"], bearer_methods_supported: ["header"] });

  const authorizationServer = (): Response =>
    json(200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read"],
    });

  // ── POST /register ──

  async function register(req: Request): Promise<Response> {
    if (limited(buckets.register)) return oauthError(429, "temporarily_unavailable", "too many registrations; retry shortly", { "Retry-After": "10" });
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return oauthError(400, "invalid_client_metadata", "send application/json");
    const raw = await readCapped(req, MAX_PUBLIC_BODY_BYTES);
    if (raw === null) return oauthError(413, "invalid_client_metadata", `the body exceeds ${MAX_PUBLIC_BODY_BYTES} bytes`);
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      meta = parsed as Record<string, unknown>;
    } catch {
      return oauthError(400, "invalid_client_metadata", "the body must be a JSON object");
    }
    const uris = meta["redirect_uris"];
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every((u) => typeof u === "string"))
      return oauthError(400, "invalid_redirect_uri", "redirect_uris must list 1-10 URIs");
    const refused = (uris as string[]).find((u) => !allowedRedirectUri(u));
    if (refused !== undefined)
      return oauthError(400, "invalid_redirect_uri", "this vault accepts only Claude's callback URLs and a loopback http://localhost/callback or http://127.0.0.1/callback");
    const grants = meta["grant_types"];
    if (grants !== undefined && !(Array.isArray(grants) && grants.includes("authorization_code")))
      return oauthError(400, "invalid_client_metadata", "grant_types must include authorization_code");
    const responses = meta["response_types"];
    if (responses !== undefined && !(Array.isArray(responses) && responses.includes("code")))
      return oauthError(400, "invalid_client_metadata", "response_types must include code");
    // A requested refresh_token grant or confidential auth method is not an
    // error: RFC 7591 §3.2.1 lets the server answer with what it registered.
    const name = (typeof meta["client_name"] === "string" && oneLine(meta["client_name"], 100)) || "An unnamed app";
    const client = clients.register(name, [...new Set(uris as string[])]);
    return json(201, {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.parse(client.created) / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read",
    });
  }

  // ── GET /authorize ──

  function authorize(req: Request, url: URL): Response {
    if (limited(buckets.pages)) return refusalPage(429, "Too many requests", "Please wait a moment and try again.");
    const q = url.searchParams;
    for (const key of new Set(q.keys()))
      if (q.getAll(key).length > 1) return refusalPage(400, "Invalid request", `The parameter ${key} was sent more than once.`);

    // Until the redirect URI is known good, every error is a page: an
    // error REDIRECT to an unvetted URI is an open redirect.
    const client = clients.get(q.get("client_id"));
    if (!client) return refusalPage(400, "Unknown app", `This app isn't registered with this vault. ${START_AGAIN}`);
    const redirectUri = q.get("redirect_uri");
    if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri))
      return refusalPage(400, "Unknown return address", "This app asked to return somewhere it did not register. Nothing was shared.");

    const state = q.get("state");
    const fail = (error: string, description: string): Response => {
      const to = new URL(redirectUri);
      to.searchParams.set("error", error);
      to.searchParams.set("error_description", description);
      if (state !== null) to.searchParams.set("state", state);
      return redirect(to.href);
    };
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
    const challenge = q.get("code_challenge");
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/u.test(challenge) || q.get("code_challenge_method") !== "S256")
      return fail("invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256");
    const scope = q.get("scope");
    if (scope !== null && !scope.split(" ").filter(Boolean).every((s) => s === "read"))
      return fail("invalid_scope", "the only scope is read");
    const resource = q.get("resource");
    if (resource !== null && resource !== resourceUrl) return fail("invalid_target", `the only resource is ${resourceUrl}`);
    if (state !== null && state.length > 2048) return fail("invalid_request", "state is too long");

    prune();
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
    // One cookie per browser, reused across tabs so two connections can be
    // in flight; each authorization keeps only the cookie's hash.
    const cookie = cookieOf(req) ?? random();
    const p: Pending = {
      id: random(18),
      csrf: random(),
      browser: sha256(cookie),
      expires: now() + PENDING_TTL_MS,
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri,
      codeChallenge: challenge,
      state,
    };
    pending.set(p.id, p);
    clients.touch(client.client_id);
    const res = authorizePage(p);
    res.headers.set("Set-Cookie", setCookie(cookie));
    return res;
  }

  // ── Google sign-in ──

  function googleStart(req: Request, url: URL): Response {
    if (!google) return refusalPage(404, "Not available", "Google sign-in isn't configured for this vault. Use an invite link.");
    if (limited(buckets.pages)) return refusalPage(429, "Too many requests", "Please wait a moment and try again.");
    const p = bound(req, url.searchParams.get("pending"));
    if (!p) return expiredPage();
    p.google = { state: random(), nonce: random() };
    const to = new URL(GOOGLE_AUTH_URL);
    to.searchParams.set("client_id", google.clientId);
    to.searchParams.set("redirect_uri", googleCallback);
    to.searchParams.set("response_type", "code");
    to.searchParams.set("scope", "openid email");
    to.searchParams.set("state", p.google.state);
    to.searchParams.set("nonce", p.google.nonce);
    to.searchParams.set("prompt", "select_account");
    return redirect(to.href);
  }

  /** The id_token's claims, checked; or the reason for the server log. */
  async function googleIdentity(code: string, nonce: string): Promise<{ sub: string; email: string } | { refused: string }> {
    let res: Response;
    try {
      res = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          code,
          client_id: google!.clientId,
          client_secret: google!.clientSecret,
          redirect_uri: googleCallback,
          grant_type: "authorization_code",
        }).toString(),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
    } catch {
      return { refused: "google token endpoint unreachable" };
    }
    if (!res.ok) return { refused: `google token endpoint answered ${res.status}` };
    let claims: Record<string, unknown>;
    try {
      const body = (await res.json()) as { id_token?: unknown };
      const payload = typeof body.id_token === "string" ? body.id_token.split(".")[1] : undefined;
      claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
      if (typeof claims !== "object" || claims === null) throw new Error("no claims");
    } catch {
      return { refused: "google answered without a readable id_token" };
    }
    const aud = claims["aud"];
    if (!GOOGLE_ISSUERS.includes(String(claims["iss"]))) return { refused: "id_token iss is not Google" };
    if (!(aud === google!.clientId || (Array.isArray(aud) && aud.includes(google!.clientId) && claims["azp"] === google!.clientId)))
      return { refused: "id_token aud is not this client" };
    if (typeof claims["exp"] !== "number" || claims["exp"] * 1000 <= now()) return { refused: "id_token expired" };
    if (typeof claims["nonce"] !== "string" || !sameSecret(claims["nonce"], nonce)) return { refused: "id_token nonce mismatch" };
    if (claims["email_verified"] !== true) return { refused: "email not verified by Google" };
    if (typeof claims["sub"] !== "string" || !claims["sub"] || typeof claims["email"] !== "string" || !claims["email"])
      return { refused: "id_token lacks sub or email" };
    return { sub: claims["sub"], email: claims["email"] };
  }

  async function googleCallbackRoute(req: Request, url: URL): Promise<Response> {
    if (!google) return refusalPage(404, "Not available", "Google sign-in isn't configured for this vault.");
    if (limited(buckets.pages)) return refusalPage(429, "Too many requests", "Please wait a moment and try again.");
    const state = url.searchParams.get("state");
    prune();
    const owner = state ? [...pending.values()].find((one) => one.google && sameSecret(one.google.state, state)) : undefined;
    const p = owner && bound(req, owner.id);
    if (!p || !p.google) return expiredPage();
    const { nonce } = p.google;
    delete p.google; // a Google state answers once
    if (url.searchParams.get("error")) return authorizePage(p, "Google sign-in was cancelled. You can try again or use an invite link.");
    const code = url.searchParams.get("code");
    if (!code) return authorizePage(p, "Google didn't complete the sign-in. Try again.", 400);

    const who = await googleIdentity(code, nonce);
    if ("refused" in who) {
      warn("google sign-in refused", { reason: who.refused });
      return authorizePage(p, "Google sign-in couldn't be verified. Try again, or use an invite link.", 400);
    }
    const bind = bindMemberIdentity(deps.storePath, { iss: GOOGLE_ISSUERS[0]!, sub: who.sub, email: who.email }, deps.now());
    if (!bind.ok) {
      warn("google sign-in matched no member", { reason: bind.reason });
      return bind.reason === "bound-elsewhere"
        ? refusalPage(403, "A different account", "This email belongs to a member who signed in with a different Google account. Ask the vault's owner.")
        : refusalPage(403, "Not a member", "You're not a member of this vault. Ask its owner to add you.");
    }
    return signedIn(p, bind.member, who.email);
  }

  // ── POST /authorize/invite ──

  async function inviteLogin(req: Request): Promise<Response> {
    if (limited(buckets.pages)) return refusalPage(429, "Too many requests", "Please wait a moment and try again.");
    const form = await formBody(req);
    if (typeof form === "string") return refusalPage(400, "Invalid request", form);
    const p = bound(req, form.get("pending"), form.get("csrf"));
    if (!p) return expiredPage();
    // A whole link (https://host/invite#<secret>) or the bare secret.
    const raw = (form.get("invite") ?? "").trim();
    const secret = raw.includes("#") ? raw.slice(raw.lastIndexOf("#") + 1) : raw;
    const member = identifyBySharedInvite(deps.storePath, secret, deps.now());
    if (!member) {
      warn("invite sign-in refused");
      return authorizePage(p, "That invite link isn't valid. It may have been used already, cancelled, or expired.", 400);
    }
    return signedIn(p, member, "invite link");
  }

  // ── POST /authorize/consent ──

  async function consent(req: Request): Promise<Response> {
    if (limited(buckets.pages)) return refusalPage(429, "Too many requests", "Please wait a moment and try again.");
    const form = await formBody(req);
    if (typeof form === "string") return refusalPage(400, "Invalid request", form);
    const p = bound(req, form.get("pending"), form.get("csrf"));
    if (!p || !p.member) return expiredPage();
    pending.delete(p.id); // one decision per authorization
    const back = new URL(p.redirectUri);
    if (p.state !== null) back.searchParams.set("state", p.state);
    if (form.get("decision") !== "approve") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "the member denied access");
      return redirect(back.href, 303);
    }
    const ok = readableMember(p.member.id);
    if (ok === "gone") return refusalPage(403, "Not a member", "Your membership has ended. Nothing was shared.");
    if (ok === "no-read") return refusalPage(403, "No read access", "Your membership doesn't include read access. Nothing was shared.");
    const code = random();
    codes.set(sha256(code), {
      clientId: p.clientId,
      clientName: p.clientName,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      memberId: ok.id,
      handle: ok.handle,
      expires: now() + CODE_TTL_MS,
      used: false,
    });
    back.searchParams.set("code", code);
    return redirect(back.href, 303);
  }

  // ── POST /token ──

  async function token(req: Request): Promise<Response> {
    if (limited(buckets.token)) return oauthError(429, "temporarily_unavailable", "too many token requests; retry shortly", { "Retry-After": "5" });
    const form = await formBody(req);
    if (typeof form === "string") return oauthError(400, "invalid_request", form);
    const grant = form.get("grant_type");
    if (!grant) return oauthError(400, "invalid_request", "grant_type is required");
    if (grant !== "authorization_code") return oauthError(400, "unsupported_grant_type", "only authorization_code is supported");
    const code = form.get("code");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    if (!code || !clientId || !redirectUri || !verifier)
      return oauthError(400, "invalid_request", "code, client_id, redirect_uri and code_verifier are required");
    const client = clients.get(clientId);
    if (!client) return oauthError(401, "invalid_client", "unknown client_id");

    prune();
    const record = codes.get(sha256(code));
    if (!record) return oauthError(400, "invalid_grant", "unknown or expired code");
    if (record.used) {
      // A second use means the code leaked: retire what the first bought.
      codes.delete(sha256(code));
      try {
        if (record.credentialId) revokeCredential(deps.storePath, record.credentialId, deps.now());
        warn("authorization code replayed; its credential was revoked", { credential: record.credentialId });
      } catch {
        warn("authorization code replayed; revoking its credential FAILED", { credential: record.credentialId });
      }
      return oauthError(400, "invalid_grant", "code already used");
    }
    record.used = true; // burned by any attempt, right or wrong
    if (record.expires <= now()) return oauthError(400, "invalid_grant", "code expired");
    if (record.clientId !== clientId) return oauthError(400, "invalid_grant", "code was issued to another client");
    if (record.redirectUri !== redirectUri) return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
    const challenge = /^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) ? createHash("sha256").update(verifier).digest("base64url") : "";
    if (!challenge || !sameSecret(challenge, record.codeChallenge)) return oauthError(400, "invalid_grant", "code_verifier does not match");
    const resource = form.get("resource");
    if (resource !== null && resource !== resourceUrl) return oauthError(400, "invalid_target", `the only resource is ${resourceUrl}`);

    let minted: ReturnType<typeof mintCredential>;
    try {
      minted = mintCredential(deps.storePath, record.handle, {
        name: oneLine(`Claude connector · ${record.clientName}`, 120),
        kind: "agent",
        scopes: ["read"],
      }, deps.now());
    } catch (error) {
      if (error instanceof SharedMemberBusyError) return oauthError(503, "temporarily_unavailable", "membership is being updated; retry", { "Retry-After": "2" });
      if (error instanceof SharedMemberError) return oauthError(400, "invalid_grant", "the member can no longer read this vault");
      throw error;
    }
    record.credentialId = minted.credential.id;
    clients.touch(clientId);
    return json(200, { access_token: minted.token, token_type: "Bearer", scope: "read" }, { Pragma: "no-cache" });
  }

  // ── the public route table ──

  type Handler = (req: Request, url: URL) => Response | Promise<Response>;
  const ROUTES: Record<string, Partial<Record<"GET" | "POST", Handler>>> = {
    "/.well-known/oauth-protected-resource": { GET: protectedResource },
    [`/.well-known/oauth-protected-resource${MCP_PATH}`]: { GET: protectedResource },
    "/.well-known/oauth-authorization-server": { GET: authorizationServer },
    "/register": { POST: register },
    "/authorize": { GET: authorize },
    "/authorize/invite": { POST: inviteLogin },
    "/authorize/consent": { POST: consent },
    "/oauth/google": { GET: googleStart },
    "/oauth/google/callback": { GET: googleCallbackRoute },
    "/token": { POST: token },
  };

  return {
    resourceUrl,
    async handlePublic(req, url) {
      const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
      if (!route) return undefined;
      const handler = Object.hasOwn(route, req.method) ? route[req.method as "GET" | "POST"] : undefined;
      if (!handler) return json(405, { error: "method not allowed" }, { Allow: Object.keys(route).join(", ") });
      try {
        return await handler(req, url);
      } catch (error) {
        if (error instanceof SharedMemberBusyError) return refusalPage(503, "Busy", "Membership is being updated. Please retry in a moment.");
        warn("unhandled error", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
        return json(500, { error: "internal error" });
      }
    },
    unauthorized: () => json(401, { error: "unauthorized" }, { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` }),
  };
}
