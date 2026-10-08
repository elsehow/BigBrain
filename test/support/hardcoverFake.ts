/** A local stand-in for Hardcover: its OAuth server (discovery, PKCE code
 * exchange, rotating refresh tokens that revoke their chain when one is used
 * twice, revocation) and its GraphQL endpoint. Every token it issues is
 * invented here; nothing reaches hardcover.app. `approve` plays the person
 * approving in their browser and follows the redirect back to BigBrain. */
import { createHash } from "node:crypto";

export interface FakeRequest { operationName: string; query: string; variables: Record<string, unknown>; userAgent: string | null; token: string }
export interface FakeHardcover {
  issuer: string;
  endpoint: string;
  /** Who `me` says is signed in. */
  user: { id: number; username: string };
  /** The `scope` the token endpoint grants; undefined leaves it out. */
  scope: string | undefined;
  /** Seconds an access token lasts. */
  expiresIn: number;
  /** Whether a refresh hands out a new refresh token. */
  rotate: boolean;
  /** Overrides the discovery document's fields (a wrong issuer, an unreachable token endpoint). */
  discovery: Record<string, unknown>;
  /** Answers a query other than BigBrainMe: data, or a Response to send as is. */
  answer: (r: FakeRequest) => unknown | Response | Promise<unknown | Response>;
  /** Runs before the token endpoint answers. */
  beforeToken: (grant: string) => void | Promise<void>;
  requests: FakeRequest[];
  /** Every refresh token the token endpoint was sent, in order. */
  refreshes: string[];
  /** Every token it issued, to prove none leaks into an error. */
  issued: string[];
  revoked: string[];
  /** Codes redeemed at the token endpoint. */
  exchanged: string[];
  /** Approve the authorization URL BigBrain opened; returns the callback's response. `tamper` edits the redirect's parameters. */
  approve(url: string, tamper?: (params: URLSearchParams) => void): Promise<Response>;
  stop(): void;
}

export function fakeHardcover(): FakeHardcover {
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const live = new Set<string>(), spent = new Set<string>();
  let n = 0;
  const mint = (kind: "at" | "rt") => { const t = `hc_${kind}_fixture${++n}`; fake.issued.push(t); return t; };
  const tokens = () => {
    const access = mint("at"); live.add(access);
    return { access_token: access, token_type: "Bearer", expires_in: fake.expiresIn, ...(fake.scope !== undefined ? { scope: fake.scope } : {}) };
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: fake.issuer, authorization_endpoint: fake.issuer + "/authorize",
      token_endpoint: fake.issuer + "/token", revocation_endpoint: fake.issuer + "/revoke", response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true, ...fake.discovery });
    if (u.pathname === "/token") {
      const f = new URLSearchParams(await req.text()), grant = f.get("grant_type") ?? "";
      if (grant === "refresh_token") fake.refreshes.push(f.get("refresh_token") ?? "");
      await fake.beforeToken(grant);
      if (grant === "authorization_code") {
        const code = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        if (!code || code.redirect !== f.get("redirect_uri") || code.client !== f.get("client_id") || createHash("sha256").update(verifier).digest("base64url") !== code.challenge)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        fake.exchanged.push(f.get("code")!);
        const refresh = mint("rt"); live.add(refresh);
        return Response.json({ ...tokens(), refresh_token: refresh });
      }
      if (grant === "refresh_token") {
        const sent = f.get("refresh_token") ?? "";
        // reuse revokes the whole chain, as Hardcover does
        if (spent.has(sent)) { live.clear(); return Response.json({ error: "invalid_grant" }, { status: 400 }); }
        if (!live.has(sent)) return Response.json({ error: "invalid_grant" }, { status: 400 });
        live.delete(sent); spent.add(sent);
        const next = fake.rotate ? mint("rt") : undefined;
        if (next) live.add(next);
        return Response.json({ ...tokens(), ...(next ? { refresh_token: next } : {}) });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (u.pathname === "/revoke") { const t = new URLSearchParams(await req.text()).get("token") ?? ""; fake.revoked.push(t); live.delete(t); return new Response(null, { status: 200 }); }
    if (u.pathname === "/v1/graphql") {
      const token = /^Bearer (.+)$/u.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      const body = await req.json() as { operationName: string; query: string; variables?: Record<string, unknown> };
      const request: FakeRequest = { operationName: body.operationName, query: body.query, variables: body.variables ?? {}, userAgent: req.headers.get("user-agent"), token };
      fake.requests.push(request);
      if (!live.has(token)) return Response.json({ error: "invalid_token" }, { status: 401 });
      if (body.operationName === "BigBrainMe") return Response.json({ data: { me: [fake.user] } });
      const answer = await fake.answer(request);
      return answer instanceof Response ? answer : Response.json({ data: answer });
    }
    return new Response("missing", { status: 404 });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  const fake: FakeHardcover = {
    issuer: base, endpoint: base + "/v1/graphql", user: { id: 4242, username: "fixture_reader" },
    scope: "read:me:content read:library read:catalog:search read:catalog:data", expiresIn: 604_800, rotate: true, discovery: {},
    answer: () => ({}), beforeToken: () => {}, requests: [], refreshes: [], issued: [], revoked: [], exchanged: [],
    async approve(url, tamper) {
      const auth = new URL(url), p = auth.searchParams, code = "code-" + crypto.randomUUID();
      codes.set(code, { challenge: p.get("code_challenge") ?? "", redirect: p.get("redirect_uri") ?? "", client: p.get("client_id") ?? "" });
      const back = new URLSearchParams({ code, state: p.get("state") ?? "", iss: fake.issuer });
      tamper?.(back);
      return fetch(p.get("redirect_uri") + "?" + back);
    },
    stop: () => server.stop(true),
  };
  return fake;
}
