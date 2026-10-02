/**
 * The shared door's Claude connector, handler-level: OAuth discovery,
 * dynamic registration, Google and invite-link sign-in, consent, the PKCE
 * token exchange, and the read-only `/mcp` it unlocks — all through
 * `makeSharedApiHandler` with `new Request(...)`, a fake Google behind the
 * injected `fetch`, and an injected clock. No socket, no network.
 *
 * Every name, address and host here is invented; every vault is a scratch
 * directory.
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemberInvite, issueSharedInvite } from "../lib/sharedInvites";
import { addMember, initMemberStore, listCredentials, listMembers, mintCredential, revokeMember } from "../lib/sharedMembers";
import { connectInvite } from "../lib/sharedConnections";
import { clientsPath, HOSTED_CALLBACKS } from "../lib/sharedOAuth";
import { FONT_PATHS } from "../lib/sharedPages";
import { makeSharedApiHandler } from "../lib/sharedVaultApi";
import { provision, sharedCli } from "./support/sharedVaultSmoke";

const PUBLIC = "https://vault.example.com";
const GOOGLE_ID = "test-client.apps.example.com";
const CLAUDE = HOSTED_CALLBACKS[0];
/** The vault's name — which no page may show before sign-in. */
const VAULT = "Orchard Cooperative";

type Claims = Record<string, unknown>;

interface World {
  root: string;
  store: string;
  handler: (req: Request) => Promise<Response>;
  owner: string;
  /** ada: write member, added by the owner with an email */
  ada: string;
  logs: string[];
  /** Advance the injected clock. */
  tick: (ms: number) => void;
  now: () => Date;
  /** The fake Google: what its next id_token says, given the nonce the door
   * sent the browser off with (googleLogin records it in `nonce`). */
  google: { claims: (nonce: string) => Claims; status: number; nonce: string };
}

function world(opts: { connector?: boolean; google?: boolean } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "bb-shared-connector-"));
  const root = join(dir, "vault");
  mkdirSync(root);
  writeFileSync(join(root, ".shared-identity.json"), JSON.stringify({ id: "vault-test-0001", name: VAULT }));
  const store = join(dir, "members.json");
  const owner = initMemberStore(store, root, { handle: "owner", display: "The Owner" });
  addMember(store, { handle: "ada", display: "Ada", permissions: ["read", "write"], email: "ada@example.com" });
  const ada = mintCredential(store, "ada", { name: "laptop" });
  let t = Date.parse("2026-05-01T12:00:00Z");
  const now = (): Date => new Date(t);
  const logs: string[] = [];
  const google: World["google"] = {
    claims: (nonce) => ({ iss: "https://accounts.google.com", aud: GOOGLE_ID, sub: "g-1001", email: "ada@example.com", email_verified: true, exp: t / 1000 + 300, nonce }),
    status: 200,
    nonce: "",
  };
  const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    expect(input).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("client_id")).toBe(GOOGLE_ID);
    expect(form.get("redirect_uri")).toBe(`${PUBLIC}/oauth/google/callback`);
    expect(form.get("grant_type")).toBe("authorization_code");
    if (google.status !== 200) return new Response("{}", { status: google.status });
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    return Response.json({ access_token: "ya29.fake", id_token: `${b64({ alg: "RS256" })}.${b64(google.claims(google.nonce))}.sig` });
  };
  const handler = makeSharedApiHandler({
    root,
    storePath: store,
    now,
    log: (line) => logs.push(line),
    ...(opts.connector === false ? {} : { connector: { publicUrl: PUBLIC, ...(opts.google === false ? {} : { google: { clientId: GOOGLE_ID, clientSecret: "test-secret" } }) } }),
    fetch: fakeFetch,
  });
  return { root, store, handler, owner: owner.token, ada: ada.token, logs, now, google, tick: (ms) => { t += ms; } };
}

const req = (w: World, method: string, path: string, init: { token?: string; json?: unknown; form?: Record<string, string>; cookie?: string; headers?: Record<string, string>; raw?: string; type?: string } = {}): Promise<Response> => {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers["Authorization"] = `Bearer ${init.token}`;
  if (init.cookie) headers["Cookie"] = init.cookie;
  let body: string | undefined;
  if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  if (init.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(init.form).toString(); }
  if (init.raw !== undefined) { headers["Content-Type"] = init.type ?? "application/json"; body = init.raw; }
  return w.handler(new Request(`${PUBLIC}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }));
};

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(w: World, redirectUris: string[] = [CLAUDE], name = "Claude"): Promise<string> {
  const res = await req(w, "POST", "/register", { json: { client_name: name, redirect_uris: redirectUris, grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" } });
  expect(res.status).toBe(201);
  return (await res.json()).client_id;
}

interface Session {
  clientId: string;
  redirectUri: string;
  verifier: string;
  cookie: string;
  pending: string;
  csrf: string;
  state: string;
}

/** A page's text with the escapes it needs undone, for reading assertions. */
const pageText = async (res: Response): Promise<string> =>
  (await res.text()).replace(/&#39;/gu, "'").replace(/&quot;/gu, '"').replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");

const field = (html: string, name: string): string => new RegExp(`name="${name}" value="([^"]+)"`, "u").exec(html)?.[1] ?? "";

async function authorize(w: World, opts: { clientId?: string; redirectUri?: string; cookie?: string; extra?: Record<string, string> } = {}): Promise<Session> {
  const redirectUri = opts.redirectUri ?? CLAUDE;
  const clientId = opts.clientId ?? (await register(w, [redirectUri]));
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString("hex");
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state, scope: "read", resource: `${PUBLIC}/mcp`, ...opts.extra });
  const res = await req(w, "GET", `/authorize?${q}`, opts.cookie ? { cookie: opts.cookie } : {});
  expect(res.status).toBe(200);
  const html = await res.text();
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]!;
  // With Google the pending id rides in its button; without, in the invite form.
  const pending = field(html, "pending") || decodeURIComponent(/\/oauth\/google\?pending=([^"&]+)/u.exec(html)?.[1] ?? "");
  return { clientId, redirectUri, verifier, cookie, pending, csrf: field(html, "csrf"), state };
}

/** A consent page carries the CSRF token the consent POST needs. */
async function onConsent(s: Session, res: Response): Promise<Response> {
  if (res.status === 200) {
    const csrf = field(await res.clone().text(), "csrf");
    if (csrf) s.csrf = csrf;
  }
  return res;
}

/** Through Google: the redirect out, then the callback with a fake code. */
async function googleLogin(w: World, s: Session, cookie = s.cookie): Promise<Response> {
  const out = await req(w, "GET", `/oauth/google?pending=${encodeURIComponent(s.pending)}`, { cookie: s.cookie });
  expect(out.status).toBe(302);
  const to = new URL(out.headers.get("location")!);
  expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(to.searchParams.get("scope")).toBe("openid email profile");
  expect(to.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/oauth/google/callback`);
  w.google.nonce = to.searchParams.get("nonce")!;
  return onConsent(s, await req(w, "GET", `/oauth/google/callback?state=${encodeURIComponent(to.searchParams.get("state")!)}&code=fake-google-code`, { cookie }));
}

const inviteLogin = async (w: World, s: Session, invite: string, overrides: { cookie?: string; csrf?: string } = {}): Promise<Response> =>
  onConsent(s, await req(w, "POST", "/authorize/invite", { cookie: overrides.cookie ?? s.cookie, form: { pending: s.pending, csrf: overrides.csrf ?? s.csrf, invite } }));

const decide = (w: World, s: Session, decision: "approve" | "deny", overrides: { cookie?: string; csrf?: string } = {}): Promise<Response> =>
  req(w, "POST", "/authorize/consent", { cookie: overrides.cookie ?? s.cookie, form: { pending: s.pending, csrf: overrides.csrf ?? s.csrf, decision } });

async function approvedCode(w: World, s: Session): Promise<string> {
  const res = await decide(w, s, "approve");
  expect(res.status).toBe(303);
  const back = new URL(res.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(new URL(s.redirectUri).origin + new URL(s.redirectUri).pathname);
  expect(back.searchParams.get("state")).toBe(s.state);
  return back.searchParams.get("code")!;
}

const exchange = (w: World, s: Session, code: string, overrides: Record<string, string> = {}): Promise<Response> =>
  req(w, "POST", "/token", { form: { grant_type: "authorization_code", code, client_id: s.clientId, redirect_uri: s.redirectUri, code_verifier: s.verifier, resource: `${PUBLIC}/mcp`, ...overrides } });

/** The whole Google path to a token. */
async function googleToken(w: World): Promise<{ token: string; session: Session }> {
  const s = await authorize(w);
  const consent = await googleLogin(w, s);
  expect(consent.status).toBe(200);
  const res = await exchange(w, s, await approvedCode(w, s));
  expect(res.status).toBe(200);
  return { token: (await res.json()).access_token, session: s };
}

let rpcId = 0;
async function mcp(w: World, token: string | undefined, method: string, params?: unknown, opts: { notification?: boolean } = {}): Promise<Response> {
  return req(w, "POST", "/mcp", {
    ...(token ? { token } : {}),
    json: { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}), ...(opts.notification ? {} : { id: ++rpcId }) },
    headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
  });
}

async function tool(w: World, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const res = await mcp(w, token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { text: body.result.content[0].text, isError: Boolean(body.result.isError) };
}

async function drop(w: World, token: string, title: string, body: string): Promise<string> {
  const res = await req(w, "POST", "/v1/evidence", { token, json: { title, body } });
  expect(res.status).toBeLessThan(300);
  return (await res.json()).id;
}

async function claim(w: World, token: string, text: string, sources: string[]): Promise<string> {
  const res = await req(w, "POST", "/v1/assertions", { token, json: { text, sources } });
  expect(res.status).toBeLessThan(300);
  return (await res.json()).id;
}

const NEW_PATHS: [string, string][] = [
  ["GET", "/.well-known/oauth-protected-resource"],
  ["GET", "/.well-known/oauth-protected-resource/mcp"],
  ["GET", "/.well-known/oauth-authorization-server"],
  ["POST", "/register"],
  ["GET", "/authorize"],
  ["POST", "/authorize/invite"],
  ["POST", "/authorize/consent"],
  ["GET", "/oauth/google"],
  ["GET", "/oauth/google/callback"],
  ["POST", "/token"],
  ["POST", "/mcp"],
  ["GET", "/mcp"],
  ["DELETE", "/mcp"],
];

describe("connector disabled (no public URL): the door is unchanged", () => {
  test("every connector path is an undifferentiated 401 without a credential, and 404 with one", async () => {
    const w = world({ connector: false });
    for (const [method, path] of NEW_PATHS) {
      const res = await req(w, method, path, method === "POST" ? { json: {} } : {});
      expect([method, path, res.status, res.headers.get("www-authenticate")]).toEqual([method, path, 401, "Bearer"]);
      const authed = await req(w, method, path, { token: w.ada, ...(method === "POST" ? { json: {} } : {}) });
      expect([method, path, authed.status]).toEqual([method, path, 404]);
    }
  });
});

describe("discovery", () => {
  test("protected-resource and authorization-server metadata have exactly the advertised fields", async () => {
    const w = world();
    const prm = { resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC], scopes_supported: ["read"], bearer_methods_supported: ["header"] };
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await req(w, "GET", path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(prm);
    }
    const as = await req(w, "GET", "/.well-known/oauth-authorization-server");
    expect(await as.json()).toEqual({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      registration_endpoint: `${PUBLIC}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read"],
    });
    // Issued URLs come from the configured origin, never the Host header.
    const spoofed = await w.handler(new Request("https://attacker.example.net/.well-known/oauth-authorization-server", { headers: { Host: "attacker.example.net" } }));
    expect((await spoofed.json()).issuer).toBe(PUBLIC);
    expect((await req(w, "POST", "/.well-known/oauth-authorization-server", { json: {} })).status).toBe(405);
    // only the exact public paths are public; a near miss is the door's 401
    for (const path of ["/authorize/", "/token/x", "/.well-known/oauth-protected-resource/other", "/register?x"])
      expect([path, (await req(w, path.startsWith("/register") ? "POST" : "GET", path.replace("?x", "x"))).status]).toEqual([path, 401]);
  });

  test("/mcp without a live credential is 401 pointing at the resource metadata", async () => {
    const w = world();
    for (const token of [undefined, "sv_deadbeef_nope", "garbage"]) {
      const res = await mcp(w, token, "tools/list");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`);
    }
    // Every other path still answers a stranger with the plain 401.
    expect((await req(w, "GET", "/v1/whoami")).headers.get("www-authenticate")).toBe("Bearer");
  });

  test("a public URL must be https (http only on loopback) and a bare origin", () => {
    for (const bad of ["http://vault.example.com", "https://vault.example.com/shared", "ftp://vault.example.com", "not a url", "https://u:p@vault.example.com"])
      expect(() => makeSharedApiHandler({ root: "/nonexistent", storePath: "/nonexistent.json", connector: { publicUrl: bad } })).toThrow();
    for (const ok of ["http://127.0.0.1:4749", "http://localhost:4749", "https://vault.example.com/"])
      expect(() => makeSharedApiHandler({ root: "/nonexistent", storePath: "/nonexistent.json", connector: { publicUrl: ok } })).not.toThrow();
  });
});

describe("dynamic client registration", () => {
  test("Claude's callbacks and loopback /callback are accepted; anything else is refused", async () => {
    const w = world();
    for (const uris of [[HOSTED_CALLBACKS[0]], [HOSTED_CALLBACKS[1]], ["http://localhost:3118/callback"], ["http://127.0.0.1/callback"], ["http://localhost/callback", "http://127.0.0.1:9/callback"]]) {
      const res = await req(w, "POST", "/register", { json: { client_name: "Claude", redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "client_secret_post" } });
      expect([uris, res.status]).toEqual([uris, 201]);
      const body = await res.json();
      expect(body).toMatchObject({ redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], client_name: "Claude" });
      expect(body.client_secret).toBeUndefined();
      expect(body.client_id).toMatch(/^bbc_/u);
    }
    for (const uri of [
      "https://evil.example.com/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback/", "https://claude.ai/api/mcp/auth_callback?x=1",
      "http://claude.ai/api/mcp/auth_callback", "http://localhost:3000/other", "http://localhost:3000/callback?x=1", "http://localhost:3000/callback#f",
      "https://localhost/callback", "http://[::1]:3000/callback", "http://127.0.0.2/callback", "http://user@localhost/callback", "javascript:alert(1)",
      "http://localhost:3000/%63allback",
    ]) {
      const res = await req(w, "POST", "/register", { json: { redirect_uris: [uri] } });
      expect([uri, res.status, (await res.json()).error]).toEqual([uri, 400, "invalid_redirect_uri"]);
    }
    w.tick(60_000); // past the registration rate limit
    expect((await req(w, "POST", "/register", { json: { redirect_uris: [] } })).status).toBe(400);
    expect((await req(w, "POST", "/register", { json: { redirect_uris: [CLAUDE], grant_types: ["client_credentials"] } })).status).toBe(400);
    expect((await req(w, "POST", "/register", { raw: "{not json" })).status).toBe(400);
    expect((await req(w, "POST", "/register", { raw: "redirect_uris=x", type: "application/x-www-form-urlencoded" })).status).toBe(400);
    expect((await req(w, "POST", "/register", { raw: JSON.stringify({ redirect_uris: [CLAUDE], client_name: "x".repeat(20_000) }) })).status).toBe(413);
    // the registry is a 0600 sidecar beside the member store
    expect(statSync(clientsPath(w.store)).mode & 0o777).toBe(0o600);
  });

  test("registration is rate-limited", async () => {
    const w = world();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await req(w, "POST", "/register", { json: { redirect_uris: [CLAUDE] } })).status);
    expect(statuses.filter((s) => s === 201).length).toBe(20);
    expect(statuses.at(-1)).toBe(429);
    w.tick(60_000);
    expect((await req(w, "POST", "/register", { json: { redirect_uris: [CLAUDE] } })).status).toBe(201);
  });
});

describe("/authorize", () => {
  test("errors before the redirect URI is vetted are pages, never redirects; later errors redirect with state", async () => {
    const w = world();
    const clientId = await register(w, [CLAUDE, "http://localhost:3118/callback"]);
    const { challenge } = pkce();
    const base = { client_id: clientId, redirect_uri: CLAUDE, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st-1" };
    const get = (params: Record<string, string>): Promise<Response> => req(w, "GET", `/authorize?${new URLSearchParams(params)}`);

    for (const params of [{ ...base, client_id: "bbc_unknown" }, { ...base, redirect_uri: "https://evil.example.com/cb" }, { ...base, redirect_uri: HOSTED_CALLBACKS[1] }, { ...base, redirect_uri: "http://127.0.0.1:3118/callback" }]) {
      const res = await get(params);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    const redirected = async (params: Record<string, string>): Promise<URL> => {
      const res = await get(params);
      expect(res.status).toBe(302);
      return new URL(res.headers.get("location")!);
    };
    const { code_challenge: _c, ...noChallenge } = base;
    for (const [params, error] of [
      [noChallenge, "invalid_request"],
      [{ ...base, code_challenge_method: "plain" }, "invalid_request"],
      [{ ...base, code_challenge: "short" }, "invalid_request"],
      [{ ...base, response_type: "token" }, "unsupported_response_type"],
      [{ ...base, scope: "read write" }, "invalid_scope"],
      [{ ...base, resource: `${PUBLIC}/other` }, "invalid_target"],
    ] as [Record<string, string>, string][]) {
      const to = await redirected(params);
      expect(to.origin + to.pathname).toBe(CLAUDE);
      expect([to.searchParams.get("error"), to.searchParams.get("state")]).toEqual([error, "st-1"]);
    }
    // a loopback redirect matches its registration on any port
    expect((await get({ ...base, redirect_uri: "http://localhost:50123/callback" })).status).toBe(200);
    // a parameter given twice is refused as a page
    expect((await req(w, "GET", `/authorize?${new URLSearchParams(base)}&state=again`)).status).toBe(400);
  });

  test("the sign-in page: escaped client name, redirect host, Google as the only login, no vault name, hardened headers, bound cookie", async () => {
    const w = world();
    const clientId = await register(w, [CLAUDE], `<script>alert("x")</script> & Co`);
    const s = await authorize(w, { clientId });
    const res = await req(w, "GET", `/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: CLAUDE, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256" })}`);
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co");
    expect(html).toContain("claude.ai");
    expect(html).toContain("read-only");
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain("/authorize/invite");
    expect(html).not.toContain('name="invite"');
    expect(html).not.toContain(VAULT);
    // the invite login does not exist in this mode, form or no form
    expect((await req(w, "POST", "/authorize/invite", { cookie: s.cookie, form: { pending: s.pending, csrf: "x", invite: "y" } })).status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("form-action");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/u);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-bb_oauth=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/u);
    expect(s.pending).not.toBe("");
  });

  test("without Google configured, the page offers only the invite link", async () => {
    const w = world({ google: false });
    const s = await authorize(w);
    const page = await req(w, "GET", `/oauth/google?pending=${s.pending}`, { cookie: s.cookie });
    expect(page.status).toBe(401);
    const res = await req(w, "GET", `/authorize?${new URLSearchParams({ client_id: s.clientId, redirect_uri: CLAUDE, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256" })}`);
    const html = await res.text();
    expect(html).not.toContain("Sign in with Google");
    expect(html).toContain("Paste an invite link");
    expect(html).not.toContain(VAULT);
  });
});

describe("sign-in with Google", () => {
  test("a member added by email binds on first sign-in, then matches by sub — even after their Google address changes", async () => {
    const w = world();
    const added = await req(w, "POST", "/v1/members", { token: w.owner, json: { name: "Grace", email: "Grace@Example.com", permission: "write" } });
    expect(added.status).toBe(201);
    const grace = await added.json();
    expect(grace.handle).toMatch(/^invite-[0-9a-f]{24}$/u);
    expect(grace.email).toBe("grace@example.com");
    expect(listCredentials(w.store, grace.handle)).toHaveLength(0);

    w.google.claims = (nonce) => ({ iss: "accounts.google.com", aud: GOOGLE_ID, sub: "g-2002", email: "grace@example.com", email_verified: true, exp: w.now().getTime() / 1000 + 300, nonce });
    const s = await authorize(w);
    const consent = await googleLogin(w, s);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("Signed in as <strong>Grace</strong> (grace@example.com)");
    expect(html).toContain(VAULT); // the vault is named once the member is signed in
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
    // bound, by the normalized issuer
    expect(listMembers(w.store).find((m) => m.handle === grace.handle)!.identity).toMatchObject({ iss: "https://accounts.google.com", sub: "g-2002" });
    // consent was shown, not skipped: no code exists until approval
    const code = await approvedCode(w, s);
    const tok = await exchange(w, s, code);
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    const body = await tok.json();
    expect(body).toEqual({ access_token: expect.stringMatching(/^sv_[0-9a-f]{8}_/u), token_type: "Bearer", scope: "read" });
    expect(body.refresh_token).toBeUndefined();
    expect(body.expires_in).toBeUndefined();

    // a second sign-in matches by sub; so does one after Google reports a new address
    for (const email of ["grace@example.com", "grace.renamed@example.org"]) {
      w.google.claims = (nonce) => ({ iss: "https://accounts.google.com", aud: GOOGLE_ID, sub: "g-2002", email, email_verified: true, exp: w.now().getTime() / 1000 + 300, nonce });
      const again = await authorize(w);
      const page = await googleLogin(w, again);
      expect([email, page.status]).toEqual([email, 200]);
      expect((await exchange(w, again, await approvedCode(w, again))).status).toBe(200);
    }
    // each connection is its own read-only agent credential
    const creds = listCredentials(w.store, grace.handle);
    expect(creds).toHaveLength(3);
    for (const c of creds) expect([c.kind, c.scopes]).toEqual(["agent", ["read"]]);
  });

  test("refusals: unverified email, wrong aud, wrong iss, wrong nonce, expired, Google error, non-member, email bound to another account", async () => {
    const w = world();
    const exp = (): number => w.now().getTime() / 1000 + 300;
    const base = (nonce: string): Claims => ({ iss: "https://accounts.google.com", aud: GOOGLE_ID, sub: "g-1001", email: "ada@example.com", email_verified: true, exp: exp(), nonce });
    const cases: [string, (nonce: string) => Claims, number, string][] = [
      ["unverified", (n) => ({ ...base(n), email_verified: false }), 400, "couldn't be verified"],
      ["unverified-string", (n) => ({ ...base(n), email_verified: "true" }), 400, "couldn't be verified"],
      ["aud", (n) => ({ ...base(n), aud: "someone-else.apps.example.com" }), 400, "couldn't be verified"],
      ["iss", (n) => ({ ...base(n), iss: "https://accounts.example.com" }), 400, "couldn't be verified"],
      ["nonce", () => base("not-the-nonce"), 400, "couldn't be verified"],
      ["expired", (n) => ({ ...base(n), exp: w.now().getTime() / 1000 - 1 }), 400, "couldn't be verified"],
      ["non-member", (n) => ({ ...base(n), sub: "g-9999", email: "stranger@example.net" }), 403, "couldn't sign you in"],
    ];
    for (const [name, claims, status, text] of cases) {
      w.google.claims = claims;
      const s = await authorize(w);
      const res = await googleLogin(w, s);
      expect([name, res.status]).toEqual([name, status]);
      expect((await pageText(res)).toLowerCase()).toContain(text.toLowerCase());
      // nothing to consent to: a consent POST finds no signed-in member
      expect((await decide(w, s, "approve")).status).toBe(400);
    }
    w.google.status = 500;
    w.google.claims = base;
    expect((await googleLogin(w, await authorize(w))).status).toBe(400);
    w.google.status = 200;

    // ada binds to g-1001 …
    expect((await googleLogin(w, await authorize(w))).status).toBe(200);
    // … so another Google account presenting her (verified) address is refused
    w.google.claims = (n) => ({ ...base(n), sub: "g-1002" });
    const other = await googleLogin(w, await authorize(w));
    expect(other.status).toBe(403);
    expect(await pageText(other)).toContain("Couldn't sign you in"); // the same page as a stranger's
    expect(listMembers(w.store).find((m) => m.handle === "ada")!.identity!.sub).toBe("g-1001");
    // no refusal left a credential behind
    expect(listCredentials(w.store, "ada").map((c) => c.name)).toEqual(["laptop"]);
  });

  test("the Google callback is bound to the browser that started it", async () => {
    const w = world();
    const s = await authorize(w);
    const stranger = (await authorize(w)).cookie;
    expect(stranger).not.toBe(s.cookie);
    for (const cookie of ["", stranger]) {
      const res = await googleLogin(w, s, cookie);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("expired");
    }
    // starting Google from a browser without the cookie is refused too
    expect((await req(w, "GET", `/oauth/google?pending=${s.pending}`)).status).toBe(400);
    // a state answers once
    const ok = await authorize(w);
    const out = await req(w, "GET", `/oauth/google?pending=${ok.pending}`, { cookie: ok.cookie });
    const to = new URL(out.headers.get("location")!);
    w.google.nonce = to.searchParams.get("nonce")!;
    const cb = `/oauth/google/callback?state=${to.searchParams.get("state")}&code=c`;
    expect((await req(w, "GET", cb, { cookie: ok.cookie })).status).toBe(200);
    expect((await req(w, "GET", cb, { cookie: ok.cookie })).status).toBe(400);
  });
});

describe("sign-in with an invite link (Google not configured)", () => {
  test("an owner-created invite becomes a member with exactly one read-only agent credential — no person credential", async () => {
    const w = world({ google: false });
    const inv = await (await req(w, "POST", "/v1/invites", { token: w.owner, json: { name: "Lin", permission: "write" } })).json();
    const s = await authorize(w);
    const consent = await inviteLogin(w, s, `${PUBLIC}/invite#${inv.secret}`);
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Signed in as <strong>Lin</strong> (invite link)");
    const res = await exchange(w, s, await approvedCode(w, s));
    const { access_token } = await res.json();
    const lin = listMembers(w.store).find((m) => m.display === "Lin")!;
    const creds = listCredentials(w.store, lin.handle);
    expect(creds.map((c) => [c.kind, c.scopes, c.revoked])).toEqual([["agent", ["read"], null]]);
    expect((await tool(w, access_token, "overview")).text).toContain("Lin (@invite-");
    // single use: the same link no longer signs anyone in, nor redeems in the app
    const again = await authorize(w);
    const refused = await inviteLogin(w, again, inv.secret);
    expect(refused.status).toBe(400);
    expect(await pageText(refused)).toContain("isn't valid");
    expect((await req(w, "POST", "/v1/invites/redeem", { token: inv.secret, json: {} })).status).toBe(401);
  });

  test("a legacy handle-bound invite identifies its member and leaves no person credential alive", async () => {
    const w = world({ google: false });
    addMember(w.store, { handle: "kai", display: "Kai", permissions: ["read"] });
    const link = issueSharedInvite(w.store, "kai", PUBLIC);
    expect(listCredentials(w.store, "kai").filter((c) => !c.revoked).map((c) => c.kind)).toEqual(["person"]);
    const s = await authorize(w);
    expect((await inviteLogin(w, s, link)).status).toBe(200);
    expect((await exchange(w, s, await approvedCode(w, s))).status).toBe(200);
    expect(listCredentials(w.store, "kai").filter((c) => !c.revoked).map((c) => [c.kind, c.scopes])).toEqual([["agent", ["read"]]]);
  });

  test("an expired invite is refused, and the invite POST needs this browser's cookie and CSRF token", async () => {
    const w = world({ google: false });
    const inv = createMemberInvite(w.store, "Mo", "read", w.now());
    const s = await authorize(w);
    expect((await inviteLogin(w, s, inv.secret, { cookie: "" })).status).toBe(400);
    expect((await inviteLogin(w, s, inv.secret, { cookie: (await authorize(w)).cookie })).status).toBe(400);
    expect((await inviteLogin(w, s, inv.secret, { csrf: "x".repeat(43) })).status).toBe(400);
    // none of those consumed the link
    w.tick(86_400_001);
    const late = await authorize(w);
    expect((await inviteLogin(w, late, inv.secret)).status).toBe(400);
    expect(listMembers(w.store).some((m) => m.display === "Mo")).toBe(false);
  });
});

describe("consent", () => {
  test("deny returns access_denied to the client with its state, and burns the authorization", async () => {
    const w = world();
    const s = await authorize(w);
    await googleLogin(w, s);
    const res = await decide(w, s, "deny");
    expect(res.status).toBe(303);
    const back = new URL(res.headers.get("location")!);
    expect([back.origin + back.pathname, back.searchParams.get("error"), back.searchParams.get("state"), back.searchParams.get("code")]).toEqual([CLAUDE, "access_denied", s.state, null]);
    expect((await decide(w, s, "approve")).status).toBe(400);
  });

  test("the consent POST is CSRF-safe and browser-bound; a pending authorization expires", async () => {
    const w = world();
    const s = await authorize(w);
    await googleLogin(w, s);
    expect((await decide(w, s, "approve", { cookie: "" })).status).toBe(400);
    expect((await decide(w, s, "approve", { cookie: (await authorize(w)).cookie })).status).toBe(400);
    expect((await decide(w, s, "approve", { csrf: "" })).status).toBe(400);
    expect((await decide(w, s, "approve", { csrf: s.csrf.slice(1) + "A" })).status).toBe(400);
    // a cross-site form post would arrive without the SameSite=Lax cookie; the right one still works
    expect((await decide(w, s, "approve")).status).toBe(303);
    const slow = await authorize(w);
    await googleLogin(w, slow);
    w.tick(10 * 60_000 + 1);
    expect((await decide(w, slow, "approve")).status).toBe(400);
  });

  test("a member without read is refused at consent; a member removed mid-flow gets nothing", async () => {
    const w = world();
    addMember(w.store, { handle: "nil", display: "Nil", permissions: [], email: "nil@example.com" });
    w.google.claims = (nonce) => ({ iss: "https://accounts.google.com", aud: GOOGLE_ID, sub: "g-3003", email: "nil@example.com", email_verified: true, exp: w.now().getTime() / 1000 + 300, nonce });
    const res = await googleLogin(w, await authorize(w));
    expect(res.status).toBe(403);
    expect(await pageText(res)).toContain("Couldn't sign you in");

    w.google.claims = (nonce) => ({ iss: "https://accounts.google.com", aud: GOOGLE_ID, sub: "g-1001", email: "ada@example.com", email_verified: true, exp: w.now().getTime() / 1000 + 300, nonce });
    const s = await authorize(w);
    expect((await googleLogin(w, s)).status).toBe(200);
    revokeMember(w.store, "ada");
    const late = await decide(w, s, "approve");
    expect(late.status).toBe(403);
    expect(late.headers.get("location")).toBeNull();
  });
});

describe("/token", () => {
  test("codes are single-use, short-lived and bound to client, redirect URI and verifier; a replay revokes what the code bought", async () => {
    const w = world();
    const s = await authorize(w);
    await googleLogin(w, s);
    const code = await approvedCode(w, s);
    const first = await exchange(w, s, code);
    expect(first.status).toBe(200);
    const { access_token } = await first.json();
    expect((await mcp(w, access_token, "ping")).status).toBe(200);
    const replay = await exchange(w, s, code);
    expect([replay.status, (await replay.json()).error]).toEqual([400, "invalid_grant"]);
    expect((await mcp(w, access_token, "ping")).status).toBe(401);

    const fresh = async (): Promise<{ s: Session; code: string }> => {
      const one = await authorize(w);
      await googleLogin(w, one);
      return { s: one, code: await approvedCode(w, one) };
    };
    const otherClient = await register(w, [CLAUDE]);
    for (const [name, overrides] of [
      ["wrong verifier", { code_verifier: pkce().verifier }],
      ["wrong client", { client_id: otherClient }],
      ["wrong redirect", { redirect_uri: HOSTED_CALLBACKS[1] }],
      ["wrong resource", { resource: `${PUBLIC}/other` }],
    ] as [string, Record<string, string>][]) {
      const { s: one, code: c } = await fresh();
      const bad = await exchange(w, one, c, overrides);
      expect([name, bad.status]).toEqual([name, 400]);
      expect(["invalid_grant", "invalid_target"]).toContain((await bad.json()).error);
      // any wrong attempt burns the code
      expect((await exchange(w, one, c)).status).toBe(400);
    }
    const { s: slow, code: late } = await fresh();
    w.tick(61_000);
    expect((await (await exchange(w, slow, late)).json()).error).toBe("invalid_grant");

    expect((await (await exchange(w, s, "nope", { client_id: "bbc_unknown" })).json()).error).toBe("invalid_client");
    expect((await (await exchange(w, s, "nope", { grant_type: "refresh_token" })).json()).error).toBe("unsupported_grant_type");
    expect((await (await req(w, "POST", "/token", { form: { grant_type: "authorization_code", code: "x" } })).json()).error).toBe("invalid_request");
    expect((await (await req(w, "POST", "/token", { json: { grant_type: "authorization_code" } })).json()).error).toBe("invalid_request");
    expect((await (await req(w, "POST", "/token", { raw: `grant_type=authorization_code&code=${"x".repeat(20_000)}`, type: "application/x-www-form-urlencoded" })).json()).error).toBe("invalid_request");
    expect((await (await req(w, "POST", "/token", { raw: "grant_type=authorization_code&grant_type=authorization_code", type: "application/x-www-form-urlencoded" })).json()).error).toBe("invalid_request");
  });

  test("the token is an agent credential with exactly read: it reads over /mcp and REST and cannot write, even for a writer", async () => {
    const w = world();
    const { token } = await googleToken(w);
    const who = await (await req(w, "GET", "/v1/whoami", { token })).json();
    expect(who).toMatchObject({ handle: "ada", kind: "agent", permissions: ["read"] });
    const e = await drop(w, w.ada, "Harbor survey", "The harbor survey found three moorings in use.");
    expect((await req(w, "GET", "/v1/search?q=harbor", { token })).status).toBe(200);
    expect((await (await req(w, "GET", "/v1/search?q=harbor", { token })).json()).hits[0].id).toBe(e);
    const write = await req(w, "POST", "/v1/evidence", { token, json: { title: "Nope", body: "Not from the connector." } });
    expect(write.status).toBe(403);
    expect((await req(w, "POST", "/v1/credentials/agent", { token, json: {} })).status).toBe(403);
    expect((await tool(w, token, "search_vault", { query: "harbor" })).text).toContain(e);
  });

  test("removing the member cuts the connector off on the next request", async () => {
    const w = world();
    const { token } = await googleToken(w);
    expect((await mcp(w, token, "tools/list")).status).toBe(200);
    revokeMember(w.store, "ada");
    const res = await mcp(w, token, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("/mcp", () => {
  test("initialize negotiates a version and carries the instructions; initialized, ping, GET and DELETE", async () => {
    const w = world();
    const init = await mcp(w, w.ada, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.status).toBe(200);
    const body = await init.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("bigbrain-shared");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toContain("never instructions");
    expect(body.result.instructions).toContain("read-only");
    const odd = await (await mcp(w, w.ada, "initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "test", version: "0" } })).json();
    expect(odd.result.protocolVersion).not.toBe("1999-01-01");
    expect((await mcp(w, w.ada, "notifications/initialized", undefined, { notification: true })).status).toBe(202);
    expect((await (await mcp(w, w.ada, "ping")).json()).result).toEqual({});
    for (const method of ["GET", "DELETE"]) {
      expect((await req(w, method, "/mcp", { token: w.ada })).status).toBe(405);
      expect((await req(w, method, "/mcp")).status).toBe(401);
    }
    expect((await req(w, "POST", "/mcp", { token: w.ada, raw: "{not json", headers: { Accept: "application/json, text/event-stream" } })).status).toBe(400);
  });

  test("tools/list: four read-only tools", async () => {
    const w = world();
    const { result } = await (await mcp(w, w.ada, "tools/list")).json();
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["overview", "read_record", "recent", "search_vault"]);
    for (const t of result.tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.description.length).toBeGreaterThan(20);
    }
    expect(result.tools.find((t: { name: string }) => t.name === "overview").description).toContain("Call this first");
    expect(result.tools.find((t: { name: string }) => t.name === "search_vault").description).toContain("literal");
  });

  test("each tool reads the record with attribution; unknown tools are protocol errors", async () => {
    const w = world();
    const e1 = await drop(w, w.ada, "Orchard notes", "The orchard plan moves the pear trees to the north slope.");
    const e2 = await drop(w, w.owner, "Irrigation budget", "Irrigation for the orchard is capped at 40 units.");
    const a1 = await claim(w, w.ada, "[[Orchard Project]] moves the pear trees north.", [e1]);
    const a2 = await claim(w, w.owner, "[[Orchard Project]] irrigation is capped at 40 units.", [e2, e1]);
    const retracted = await claim(w, w.ada, "[[Orchard Project]] will plant apples first.", [e1]);
    expect((await req(w, "POST", `/v1/assertions/${retracted}/retract`, { token: w.ada, json: { reason: "misread the plan" } })).status).toBeLessThan(300);

    const overview = (await tool(w, w.ada, "overview")).text;
    expect(overview).toContain(`# ${VAULT}`);
    expect(overview).toContain("You are connected as Ada (@ada)");
    expect(overview).toContain("The Owner (@owner, owner)");
    expect(overview).toContain("2 evidence item(s) and 2 live claim(s) (1 retracted");
    expect(overview).toContain('"Irrigation budget" — submitted by The Owner (@owner)');
    expect(overview).not.toContain("ada@example.com");

    const one = (await tool(w, w.ada, "search_vault", { query: "orchard pear" })).text;
    expect(one).toContain(e1);
    expect(one).not.toContain(e2);
    const many = (await tool(w, w.ada, "search_vault", { queries: ["pear trees", "irrigation", "pear north"], limit: 10 })).text;
    for (const id of [e1, e2, a1, a2]) expect(many).toContain(id);
    expect(many.split(e1).length).toBe(2); // de-duplicated
    expect(many).toContain("[claim by The Owner (@owner)] Orchard Project irrigation is capped at 40 units.");
    expect(many).not.toContain(retracted);
    expect((await tool(w, w.ada, "search_vault", { query: "volcano" })).text).toContain("Nothing in this vault matches");
    expect((await tool(w, w.ada, "search_vault", {})).isError).toBe(true);
    expect((await tool(w, w.ada, "search_vault", { query: "a", queries: ["b"] })).isError).toBe(true);

    const ev = (await tool(w, w.ada, "read_record", { id: e1 })).text;
    expect(ev).toContain("# Orchard notes");
    expect(ev).toContain("Submitted by Ada (@ada)");
    expect(ev).toContain("verified: the submitter's own words");
    expect(ev).toContain("pear trees to the north slope");
    expect(ev).toContain(a1);
    expect(ev).not.toContain(retracted);

    const live = (await tool(w, w.ada, "read_record", { id: a2 })).text;
    expect(live).toContain("Status: live");
    expect(live).toContain("By The Owner (@owner)");
    expect(live).toContain(`${e2} "Irrigation budget"`);
    const gone = (await tool(w, w.ada, "read_record", { id: retracted })).text;
    expect(gone).toContain('Status: retracted by Ada (@ada)');
    expect(gone).toContain("misread the plan");

    const entityId = /\((ent_[a-f0-9]{20})\)/u.exec(live)![1]!;
    const dossier = (await tool(w, w.ada, "read_record", { id: entityId })).text;
    expect(dossier).toContain("# Orchard Project");
    expect(dossier).toContain(a1);
    expect(dossier).toContain(a2);
    expect(dossier).not.toContain(retracted);
    expect((await tool(w, w.ada, "read_record", { id: `ent_${"0".repeat(20)}` })).text).toContain("silent");
    expect((await tool(w, w.ada, "read_record", { id: "../vault.yaml" })).isError).toBe(true);
    expect((await tool(w, w.ada, "read_record", { id: "ins_nothex" })).isError).toBe(true);

    const recent = (await tool(w, w.ada, "recent", { limit: 3 })).text;
    expect(recent).toContain("feed head #6");
    expect(recent).toContain(`retracted ${retracted}`);
    expect(recent).toContain("More: call recent with before=4");
    const older = (await tool(w, w.ada, "recent", { before: 4, limit: 3 })).text;
    expect(older).toContain('added evidence "Orchard notes"');
    expect(older).toContain("start of the vault");

    const unknown = await (await mcp(w, w.ada, "tools/call", { name: "drop", arguments: {} })).json();
    expect(unknown.error.code).toBe(-32602);
  });

  test("a long evidence body is windowed, and says how to read on", async () => {
    const w = world();
    const body = `${"a".repeat(25_000)}MIDDLE${"b".repeat(25_000)}END`;
    const id = await drop(w, w.ada, "Long transcript", body);
    const first = (await tool(w, w.ada, "read_record", { id })).text;
    expect(first).toContain(`characters 0–20000 of ${body.length}`);
    expect(first).toContain(`start=20000`);
    expect(first).not.toContain("MIDDLE");
    const second = (await tool(w, w.ada, "read_record", { id, start: 20_000, chars: 100_000 })).text;
    expect(second).toContain("MIDDLE");
    expect(second).toContain("END");
    expect(second).toContain("; end]");
    expect((await tool(w, w.ada, "read_record", { id, chars: 100_001 })).isError).toBe(true);
  });

  test("a withdrawn contribution is not readable, searchable, listed or in recent", async () => {
    const w = world();
    const id = await drop(w, w.ada, "Draft lighthouse memo", "The lighthouse keeper rota is unconfirmed.");
    const keep = await drop(w, w.owner, "Lighthouse schedule", "The lighthouse opens at dawn.");
    const contribution = (await (await req(w, "GET", "/v1/contributions", { token: w.ada })).json()).items[0];
    const withdrawn = await req(w, "POST", `/v1/contributions/${contribution.id}/withdraw`, { token: w.ada, json: { request_id: "withdraw-0001", version: contribution.version } });
    expect(withdrawn.status).toBe(200);
    const { token } = await googleToken(w);
    expect((await tool(w, token, "read_record", { id })).text).toContain("withdrawn");
    expect((await tool(w, token, "read_record", { id })).text).not.toContain("rota");
    const hits = (await tool(w, token, "search_vault", { query: "lighthouse" })).text;
    expect(hits).toContain(keep);
    expect(hits).not.toContain(id);
    for (const name of ["overview", "recent"]) {
      const text = (await tool(w, token, name)).text;
      expect(text).not.toContain(id);
      expect(text).not.toContain("Draft lighthouse memo");
    }
    // exactly as over REST
    expect((await req(w, "GET", `/v1/evidence/${id}`, { token })).status).toBe(404);
  });
});

describe("owner member management by email", () => {
  test("only the owner adds members by email or changes one; addresses are unique, normalized, and hidden from other members", async () => {
    const w = world();
    const ownerAgent = mintCredential(w.store, "owner", { name: "agent", kind: "agent" }).token;
    for (const token of [w.ada, ownerAgent]) {
      expect((await req(w, "POST", "/v1/members", { token, json: { name: "Eve", email: "eve@example.com", permission: "read" } })).status).toBe(403);
    }
    expect((await req(w, "POST", "/v1/members", { token: w.owner, json: { name: "Dup", email: "ADA@example.com", permission: "read" } })).status).toBe(400);
    for (const json of [{ name: "Bad", email: "not-an-email", permission: "read" }, { name: "Bad", email: "x@example.com", permission: "owner" }, { name: "Bad", permission: "read" }, null])
      expect((await req(w, "POST", "/v1/members", { token: w.owner, json })).status).toBe(400);

    const eve = await (await req(w, "POST", "/v1/members", { token: w.owner, json: { name: "Eve", email: " Eve@Example.COM ", permission: "read" } })).json();
    expect(eve).toMatchObject({ display: "Eve", email: "eve@example.com", permissions: ["read"], signed_in: null });

    const asOwner = await (await req(w, "GET", "/v1/members", { token: w.owner })).json();
    expect(asOwner.members.find((m: { handle: string }) => m.handle === "ada").email).toBe("ada@example.com");
    const asAda = await (await req(w, "GET", "/v1/members", { token: w.ada })).json();
    expect(JSON.stringify(asAda)).not.toContain("@example.com");
    expect(asAda.members.every((m: Record<string, unknown>) => !("email" in m) && !("identity" in m) && !("signed_in" in m))).toBe(true);

    // ada signs in and binds; changing her email unbinds, so her old Google account no longer matches
    await googleToken(w);
    const ada = listMembers(w.store).find((m) => m.handle === "ada")!;
    expect(ada.identity?.sub).toBe("g-1001");
    expect((await req(w, "POST", `/v1/members/${ada.id}/email`, { token: w.ada, json: { email: "x@example.com" } })).status).toBe(403);
    expect((await req(w, "POST", `/v1/members/${ada.id}/email`, { token: w.owner, json: { email: "eve@example.com" } })).status).toBe(400);
    const changed = await (await req(w, "POST", `/v1/members/${ada.id}/email`, { token: w.owner, json: { email: "ada.new@example.com" } })).json();
    expect(changed).toMatchObject({ email: "ada.new@example.com", signed_in: null });
    expect(listMembers(w.store).find((m) => m.handle === "ada")!.identity).toBeUndefined();
    expect((await googleLogin(w, await authorize(w))).status).toBe(403);
    // clearing removes the address and leaves nothing to match
    const cleared = await (await req(w, "POST", `/v1/members/${ada.id}/email`, { token: w.owner, json: { email: null } })).json();
    expect(cleared.email).toBeNull();
    expect((await req(w, "POST", `/v1/members/${ada.id}/email`, { token: w.owner, json: {} })).status).toBe(400);
    expect((await req(w, "POST", `/v1/members/mem_00000000/email`, { token: w.owner, json: { email: null } })).status).toBe(404);
  });

  test("the CLI sets, changes and clears emails, and refuses a duplicate or a bad public URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-shared-connector-cli-"));
    const p = provision(join(dir, "p"));
    const v = ["--vault", p.root, "--members", p.store];
    expect(sharedCli(["member", "add", "dana", ...v, "--display", "Dana", "--email", "Dana@Example.com"]).json).toMatchObject({ handle: "dana", email: "dana@example.com" });
    expect(sharedCli(["member", "add", "dee", ...v, "--email", "dana@example.com"], { expectFail: true }).err).toContain("already belongs");
    expect(sharedCli(["member", "set", "alice", ...v, "--email", "alice@example.com"]).json).toMatchObject({ handle: "alice", email: "alice@example.com", permissions: ["read", "write"] });
    expect(sharedCli(["member", "set", "alice", ...v, "--permissions", "read", "--email", "alice2@example.com"]).json).toMatchObject({ email: "alice2@example.com", permissions: ["read"] });
    expect(sharedCli(["member", "set", "alice", ...v, "--clear-email"]).json.email).toBeUndefined();
    expect(sharedCli(["member", "set", "alice", ...v], { expectFail: true }).code).toBe(1);
    expect(sharedCli(["member", "set", "alice", ...v, "--email", "a@example.com", "--clear-email"], { expectFail: true }).code).toBe(1);
    expect(sharedCli(["member", "list", ...v]).json.find((m: { handle: string }) => m.handle === "dana").email).toBe("dana@example.com");
    const serve = sharedCli(["serve", ...v, "--port", "0", "--public-url", "http://vault.example.com"], { expectFail: true });
    expect(serve.code).toBe(1);
    expect(serve.err).toContain("https");
  });
});


// ── round two: the join link, the personal page, app links, pending members ──

const claimsFor = (w: World, sub: string, email: string, extra: Claims = {}) => (nonce: string): Claims =>
  ({ iss: "https://accounts.google.com", aud: GOOGLE_ID, sub, email, email_verified: true, exp: w.now().getTime() / 1000 + 300, nonce, ...extra });

/** Sign in from `/join`: out to Google and back, with whatever cookies result. */
async function joinLogin(w: World, claims?: (nonce: string) => Claims): Promise<{ res: Response; session: string }> {
  if (claims) w.google.claims = claims;
  const out = await req(w, "GET", "/join/google");
  expect(out.status).toBe(302);
  const browser = out.headers.get("set-cookie")!.split(";")[0]!;
  const to = new URL(out.headers.get("location")!);
  expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(to.searchParams.get("scope")).toBe("openid email profile");
  expect(to.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/oauth/google/callback`);
  w.google.nonce = to.searchParams.get("nonce")!;
  const res = await req(w, "GET", `/oauth/google/callback?state=${encodeURIComponent(to.searchParams.get("state")!)}&code=fake-google-code`, { cookie: browser });
  return { res, session: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}

async function personalPage(w: World, session: string): Promise<{ res: Response; html: string; csrf: string }> {
  const res = await req(w, "GET", "/me", { cookie: session });
  const html = res.status === 200 ? await pageText(res) : "";
  return { res, html, csrf: field(html, "csrf") };
}

const APP_LINK = /https:\/\/vault\.example\.com\/invite#([A-Za-z0-9_-]{43})/u;

async function newAppLink(w: World, session: string, csrf: string): Promise<string> {
  const res = await req(w, "POST", "/me/app-link", { cookie: session, form: { csrf } });
  expect(res.status).toBe(200);
  return APP_LINK.exec(await res.text())![1]!;
}

describe("the join link and the personal page", () => {
  test("/join is the same for every visitor and says nothing about the vault", async () => {
    const w = world();
    const res = await req(w, "GET", "/join");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const secret of [VAULT, "Ada", "The Owner", "owner", "ada@example.com", "@example.com", "members", "evidence"])
      expect([secret, html.includes(secret)]).toEqual([secret, false]);
    expect(html).toContain("Sign in to a shared BigBrain");
    expect(html).toContain('href="/join/google"');
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("font-src 'self'");
    // a signed-in visitor gets the very same page
    const { session } = await joinLogin(w);
    expect(await (await req(w, "GET", "/join", { cookie: session })).text()).toBe(html);
  });

  test("an invite or app link opened in a browser explains how to use it, naming nothing", async () => {
    for (const google of [true, false]) {
      const res = await req(world({ google }), "GET", "/invite");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("To join in the BigBrain app");
      expect(html).toContain('data-href');
      expect(html).not.toContain('class="eyebrow"');
      // the Claude steps (paste the link on Claude's sign-in page) only without Google
      expect(html.includes("To join in Claude desktop")).toBe(!google);
      expect(html.includes(`${PUBLIC}/mcp`)).toBe(!google);
      for (const secret of [VAULT, "Ada", "The Owner", "ada@example.com"]) expect([secret, html.includes(secret)]).toEqual([secret, false]);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await req(world({ connector: false }), "GET", "/invite")).status).toBe(401);
  });

  test("/invite/check names the vault to a live link's holder, consumes nothing, and is one 404 otherwise", async () => {
    const w = world({ google: false });
    const { secret } = createMemberInvite(w.store, "Grace", "read", w.now());
    const check = (s: string) => req(w, "POST", "/invite/check", { headers: { Authorization: `Bearer ${s}` } });
    for (let i = 0; i < 2; i++) expect([(await check(secret)).status, await (await check(secret)).json()]).toEqual([200, { vault: VAULT }]);
    // still redeemable after being checked
    const redeemed = await req(w, "POST", "/v1/invites/redeem", { token: secret });
    expect(redeemed.status).toBe(200);
    for (const s of [secret, "x".repeat(43), "", "not a secret"]) {
      const res = await check(s);
      expect([s, res.status, await res.text()]).toEqual([s, 404, '{"error":"not found"}\n']);
    }
    expect((await req(world({ connector: false }), "POST", "/invite/check", { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(401);
  });

  test("Google sign-in from /join opens a session on /me with the connector URL and app links", async () => {
    const w = world();
    const { res, session } = await joinLogin(w);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PUBLIC}/me`);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-bb_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1800; Secure$/u);
    const me = await personalPage(w, session);
    expect(me.res.status).toBe(200);
    expect(me.res.headers.get("cache-control")).toBe("no-store");
    expect(me.html).toContain(VAULT);
    expect(me.html).toContain("Signed in as ada@example.com");
    expect(me.html).toContain(`value="${PUBLIC}/mcp"`);
    expect(me.html).toContain('action="/me/app-link"');
    expect(me.html).toContain('action="/me/signout"');
    // Copy buttons are hidden until the pinned script reveals them
    expect(me.html).toContain('data-copy="connector" hidden');
    expect(me.html).toContain("<script>");
    expect(me.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // the session lasts 30 minutes
    w.tick(30 * 60_000 + 1);
    expect((await req(w, "GET", "/me", { cookie: session })).status).toBe(303);
  });

  test("/me needs a session; its forms need the session's CSRF token; sign-out ends it", async () => {
    const w = world();
    for (const cookie of [undefined, "__Host-bb_session=" + "x".repeat(43)]) {
      const res = await req(w, "GET", "/me", cookie ? { cookie } : {});
      expect([res.status, res.headers.get("location")]).toEqual([303, `${PUBLIC}/join`]);
      expect((await req(w, "POST", "/me/app-link", { form: { csrf: "x" }, ...(cookie ? { cookie } : {}) })).status).toBe(303);
    }
    const { session } = await joinLogin(w);
    const { csrf } = await personalPage(w, session);
    for (const form of [{}, { csrf: "" }, { csrf: "y".repeat(43) }]) {
      expect((await req(w, "POST", "/me/app-link", { cookie: session, form })).status).toBe(403);
      expect((await req(w, "POST", "/me/signout", { cookie: session, form })).status).toBe(403);
    }
    expect((await req(w, "POST", "/me/app-link", { cookie: session, json: { csrf } })).status).toBe(400);
    const out = await req(w, "POST", "/me/signout", { cookie: session, form: { csrf } });
    expect([out.status, out.headers.get("location")]).toEqual([303, `${PUBLIC}/join`]);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await req(w, "GET", "/me", { cookie: session })).status).toBe(303);
  });

  test("an app link redeems once through /v1/invites/redeem, as the same member with their access, and expires in an hour", async () => {
    const w = world();
    const { session } = await joinLogin(w);
    const { csrf } = await personalPage(w, session);
    const first = await newAppLink(w, session, csrf);
    const second = await newAppLink(w, session, csrf);
    expect(first).not.toBe(second);
    const redeemed = await req(w, "POST", "/v1/invites/redeem", { token: first, json: {} });
    expect(redeemed.status).toBe(200);
    const { token, vault } = await redeemed.json();
    expect(vault.name).toBe(VAULT);
    const who = await (await req(w, "GET", "/v1/whoami", { token })).json();
    expect(who).toMatchObject({ handle: "ada", kind: "person", permissions: ["read", "write"], credential: { name: "BigBrain" } });
    const cred = listCredentials(w.store, "ada").find((c) => c.id === who.credential.id)!;
    expect(cred.followsMember).toBe(true);
    // it follows the member: narrowing ada narrows it
    const ada = listMembers(w.store).find((m) => m.handle === "ada")!;
    expect((await req(w, "POST", `/v1/members/${ada.id}/access`, { token: w.owner, json: { permission: "read" } })).status).toBe(200);
    expect((await (await req(w, "GET", "/v1/whoami", { token })).json()).permissions).toEqual(["read"]);
    // once only
    expect((await req(w, "POST", "/v1/invites/redeem", { token: first, json: {} })).status).toBe(401);
    // an hour, then gone
    w.tick(3600_000 + 1);
    expect((await req(w, "POST", "/v1/invites/redeem", { token: second, json: {} })).status).toBe(401);
    // app links never appear among the owner's pending invitations
    expect((await (await req(w, "GET", "/v1/members", { token: w.owner })).json()).invites).toEqual([]);
  });

  test("removing the member ends their /me session, and their unused app link redeems nothing", async () => {
    const w = world();
    const { session } = await joinLogin(w);
    const { csrf } = await personalPage(w, session);
    const link = await newAppLink(w, session, csrf);
    revokeMember(w.store, "ada");
    expect((await req(w, "GET", "/me", { cookie: session })).status).toBe(303);
    expect((await req(w, "POST", "/v1/invites/redeem", { token: link, json: {} })).status).toBe(401);
  });

  test("every way a sign-in fails shows one identical page, on /join and on /authorize", async () => {
    const w = world();
    addMember(w.store, { handle: "nil", display: "Nil", permissions: [], email: "nil@example.com" });
    addMember(w.store, { handle: "rex", display: "Rex", permissions: ["read"], email: "rex@example.com" });
    revokeMember(w.store, "rex");
    // ada binds first, so a second account with her address is "bound elsewhere"
    expect((await joinLogin(w, claimsFor(w, "g-1001", "ada@example.com"))).res.status).toBe(303);
    const cases: [string, (nonce: string) => Claims][] = [
      ["not a member", claimsFor(w, "g-9", "stranger@example.net")],
      ["bound elsewhere", claimsFor(w, "g-1002", "ada@example.com")],
      ["revoked", claimsFor(w, "g-7", "rex@example.com")],
      ["no read", claimsFor(w, "g-8", "nil@example.com")],
    ];
    const pages = new Set<string>();
    for (const [name, claims] of cases) {
      const viaJoin = (await joinLogin(w, claims)).res;
      expect([name, viaJoin.status, viaJoin.headers.get("set-cookie")]).toEqual([name, 403, null]);
      pages.add(await viaJoin.text());
      const s = await authorize(w);
      const viaAuthorize = await googleLogin(w, s);
      expect([name, viaAuthorize.status]).toEqual([name, 403]);
      pages.add(await viaAuthorize.text());
    }
    expect(pages.size).toBe(1);
    const [only] = [...pages];
    expect(only).toContain("Couldn&#39;t sign you in");
    for (const secret of [VAULT, "Nil", "Rex", "Ada", "@example"]) expect(only).not.toContain(secret);
    // the real reasons reach the log, the addresses do not
    const log = w.logs.join("\n");
    for (const reason of ["not-member", "bound-elsewhere", "no-read"]) expect(log).toContain(reason);
    expect(log).not.toContain("@example");
  });

  test("a /me session goes straight to consent on /authorize — consent is still shown", async () => {
    const w = world();
    const { session } = await joinLogin(w);
    const clientId = await register(w);
    const { challenge } = pkce();
    const res = await req(w, "GET", `/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: CLAUDE, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })}`, { cookie: session });
    expect(res.status).toBe(200);
    const html = await pageText(res);
    expect(html).toContain(`to read ${VAULT}?`);
    expect(html).toContain("Signed in as <strong>Ada</strong> (ada@example.com)");
    expect(html).toContain('value="approve"');
  });

  test("join, me and Google exist only with the connector AND Google; the font only with the connector", async () => {
    const paths: [string, string][] = [["GET", "/join"], ["GET", "/join/google"], ["GET", "/me"], ["POST", "/me/app-link"], ["POST", "/me/signout"], ["GET", "/oauth/google"], ["GET", "/oauth/google/callback"]];
    for (const opts of [{ google: false }, { connector: false }]) {
      const w = world(opts);
      for (const [method, path] of paths) expect([opts, path, (await req(w, method, path, method === "POST" ? { form: {} } : {})).status]).toEqual([opts, path, 401]);
      expect((await (await req(w, "GET", "/v1/members", { token: w.owner })).json()).email_invites).toBeUndefined();
    }
    const off = world({ connector: false });
    for (const path of FONT_PATHS) expect((await req(off, "GET", path)).status).toBe(401);
    for (const w of [world(), world({ google: false })]) {
      const font = await req(w, "GET", "/assets/hanken-grotesk-latin.woff2");
      expect(font.status).toBe(200);
      expect(font.headers.get("content-type")).toBe("font/woff2");
      expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect((await font.arrayBuffer()).byteLength).toBe(statSync(join(import.meta.dir, "../clients/browser-extension/fonts/hanken-grotesk-latin.woff2")).size);
    }
  });
});

describe("members by email: pending until they sign in", () => {
  test("a pending member is the owner's alone; first sign-in clears it and names them from Google", async () => {
    const w = world();
    const added = await req(w, "POST", "/v1/members", { token: w.owner, json: { email: "Grace@Example.com", permission: "read" } });
    expect(added.status).toBe(201);
    const grace = await added.json();
    expect(grace).toMatchObject({ display: "grace@example.com", email: "grace@example.com", pending: true, signed_in: null });
    const owner = await (await req(w, "GET", "/v1/members", { token: w.owner })).json();
    expect(owner).toMatchObject({ email_invites: true, join_url: `${PUBLIC}/join`, can_manage: true });
    expect(owner.members.find((m: { id: string }) => m.id === grace.id).pending).toBe(true);
    const asAda = await (await req(w, "GET", "/v1/members", { token: w.ada })).json();
    expect(asAda.members.map((m: { id: string }) => m.id)).not.toContain(grace.id);
    expect(asAda.email_invites).toBeUndefined();
    expect(asAda.join_url).toBeUndefined();
    expect((await tool(w, w.ada, "overview")).text).not.toContain("grace");

    expect((await joinLogin(w, claimsFor(w, "g-2002", "grace@example.com", { name: "Grace  Hopper\n" }))).res.status).toBe(303);
    const after = listMembers(w.store).find((m) => m.id === grace.id)!;
    expect([after.pending, after.display]).toEqual([undefined, "Grace Hopper"]);
    expect((await (await req(w, "GET", "/v1/members", { token: w.ada })).json()).members.map((m: { display: string }) => m.display)).toContain("Grace Hopper");
    expect((await tool(w, w.ada, "overview")).text).toContain("Grace Hopper");
  });

  test("an owner-set name is kept; without a Google name the address's local part is used; a pending member can be cancelled", async () => {
    const w = world();
    const lin = await (await req(w, "POST", "/v1/members", { token: w.owner, json: { name: "Lin", email: "lin@example.com", permission: "write" } })).json();
    expect(lin).toMatchObject({ display: "Lin", pending: true });
    await joinLogin(w, claimsFor(w, "g-3", "lin@example.com", { name: "Linnea Somebody" }));
    expect(listMembers(w.store).find((m) => m.id === lin.id)!.display).toBe("Lin");
    const mo = await (await req(w, "POST", "/v1/members", { token: w.owner, json: { email: "mo.k@example.com", permission: "read" } })).json();
    await joinLogin(w, claimsFor(w, "g-4", "mo.k@example.com"));
    expect(listMembers(w.store).find((m) => m.id === mo.id)!.display).toBe("mo.k");
    // cancelling an invitation is removing the pending member
    const kim = await (await req(w, "POST", "/v1/members", { token: w.owner, json: { email: "kim@example.com", permission: "read" } })).json();
    expect((await req(w, "POST", `/v1/members/${kim.id}/remove`, { token: w.owner, json: {} })).status).toBe(200);
    expect((await joinLogin(w, claimsFor(w, "g-5", "kim@example.com"))).res.status).toBe(403);
  });

  test("no route ever returns the bound identity", async () => {
    const w = world();
    await joinLogin(w); // binds ada to g-1001
    const ada = listMembers(w.store).find((m) => m.handle === "ada")!;
    const bodies = [
      await (await req(w, "GET", "/v1/members", { token: w.owner })).text(),
      await (await req(w, "GET", "/v1/members", { token: w.ada })).text(),
      await (await req(w, "POST", "/v1/members", { token: w.owner, json: { email: "zed@example.com", permission: "read" } })).text(),
      await (await req(w, "POST", `/v1/members/${ada.id}/access`, { token: w.owner, json: { permission: "read" } })).text(),
      await (await req(w, "POST", `/v1/members/${ada.id}/email`, { token: w.owner, json: { email: "ada@example.com" } })).text(),
      await (await req(w, "GET", "/v1/whoami", { token: w.ada })).text(),
      await (await req(w, "POST", `/v1/members/${ada.id}/remove`, { token: w.owner, json: {} })).text(),
    ];
    for (const body of bodies) {
      expect(body).not.toContain("identity");
      expect(body).not.toContain("g-1001");
      expect(body).not.toContain("display_placeholder");
    }
  });
});

describe("the app refuses a join link", () => {
  test("connectInvite recognises a join link and refuses it without any network request", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 401 }); }) as unknown as typeof fetch;
    try {
      const store = join(mkdtempSync(join(tmpdir(), "bb-connections-")), "connections.json");
      for (const link of [`${PUBLIC}/join`, `${PUBLIC}/join/`, `${PUBLIC}/me`, `${PUBLIC}/`, `${PUBLIC}`, `${PUBLIC}/invite`, `${PUBLIC}/join?x=1`]) {
        const error = await connectInvite(store, link).then(() => null, (e: Error) => e);
        expect([link, error?.message]).toEqual([link, expect.stringContaining("open it in your browser")]);
      }
      expect(calls).toBe(0);
      // an app link does go to the network (and here is refused by the fake)
      await connectInvite(store, `${PUBLIC}/invite#${"a".repeat(43)}`).catch(() => {});
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("no secrets in the log", () => {
  test("Google, join, app-link and invite sign-ins log pathnames only — no codes, tokens, secrets, emails or query strings", async () => {
    const w = world();
    const { token, session } = await googleToken(w);
    const joined = await joinLogin(w);
    const { csrf } = await personalPage(w, joined.session);
    const link = await newAppLink(w, joined.session, csrf);
    const redeemed = (await (await req(w, "POST", "/v1/invites/redeem", { token: link, json: {} })).json()).token;
    await tool(w, token, "overview");

    const plain = world({ google: false });
    const inv = await (await req(plain, "POST", "/v1/invites", { token: plain.owner, json: { name: "Rae", permission: "read" } })).json();
    const s = await authorize(plain);
    await inviteLogin(plain, s, inv.secret);
    const second = (await (await exchange(plain, s, await approvedCode(plain, s))).json()).access_token;

    const logs = [...w.logs, ...plain.logs];
    const all = logs.join("\n");
    for (const secret of [token, second, redeemed, link, inv.secret, session.verifier, session.cookie.split("=")[1]!, joined.session.split("=")[1]!, csrf, "ada@example.com", "fake-google-code", "test-secret"])
      expect(all).not.toContain(secret);
    for (const line of logs) {
      const row = JSON.parse(line) as { path?: string };
      if (row.path) expect(row.path).not.toContain("?");
    }
    for (const path of ["/authorize", "/token", "/join/google", "/me/app-link", "/v1/invites/redeem"]) expect(all).toContain(`"path":"${path}"`);
  });
});
