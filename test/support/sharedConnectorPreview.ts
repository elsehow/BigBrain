#!/usr/bin/env bun
/**
 * A local shared door with the Claude connector and a FAKE Google, for
 * looking at the join, personal, sign-in and consent pages in a real browser.
 *
 *   bun test/support/sharedConnectorPreview.ts [--port 4790]
 *
 * Everything is invented and lives in a temporary directory. The door is the
 * real handler (lib/sharedVaultApi.ts); only Google is replaced: a redirect
 * to accounts.google.com is rewritten to a local account picker, and the
 * door's token request goes to an injected fetch that answers with an
 * id_token for the account picked. Nothing leaves the machine.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flagValue } from "../../lib/cliflags";
import { addMember, addMemberByEmail, initMemberStore } from "../../lib/sharedMembers";
import { makeSharedApiHandler } from "../../lib/sharedVaultApi";

const port = Number(flagValue(process.argv, "port") ?? 4790);
const origin = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "bb-connector-preview-"));
const root = join(dir, "vault");
const store = join(dir, "members.json");
mkdirSync(root);
writeFileSync(join(root, "vault.yaml"), "shared: true\n");
writeFileSync(join(root, ".shared-identity.json"), JSON.stringify({ id: "preview-vault", name: "Orchard Cooperative" }));
const owner = initMemberStore(store, root, { handle: "owner", display: "Olive Owner" });
addMember(store, { handle: "ada", display: "Ada Example", permissions: ["read", "write"], email: "ada@example.com" });
addMemberByEmail(store, { email: "grace@example.com", permissions: ["read"] });

const ACCOUNTS: Record<string, { sub: string; email: string; name: string; note: string }> = {
  ada: { sub: "fake-1001", email: "ada@example.com", name: "Ada Example", note: "a member with write access" },
  grace: { sub: "fake-2002", email: "grace@example.com", name: "Grace Example", note: "invited by email, pending until this sign-in" },
  stranger: { sub: "fake-9009", email: "stranger@example.net", name: "Sam Stranger", note: "not a member" },
};

// The door's token request: the "code" names the account and carries the nonce.
const fakeGoogle = async (_input: string, init?: RequestInit): Promise<Response> => {
  const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
  const [account, nonce] = code.split(".");
  const who = ACCOUNTS[account ?? ""];
  if (!who) return new Response("{}", { status: 400 });
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { iss: "https://accounts.google.com", aud: "preview.apps.example.com", sub: who.sub, email: who.email, email_verified: true, name: who.name, exp: Math.floor(Date.now() / 1000) + 300, nonce };
  return Response.json({ id_token: `${b64({ alg: "none" })}.${b64(claims)}.` });
};

const door = makeSharedApiHandler({
  root,
  storePath: store,
  connector: { publicUrl: origin, google: { clientId: "preview.apps.example.com", clientSecret: "preview-secret" } },
  fetch: fakeGoogle,
  log: () => {},
});

const esc = (s: string): string => s.replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The stand-in for Google's account chooser. */
function picker(url: URL): Response {
  const state = url.searchParams.get("state") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  const rows = Object.entries(ACCOUNTS)
    .map(([key, a]) => `<li><a href="/oauth/google/callback?state=${encodeURIComponent(state)}&amp;code=${encodeURIComponent(`${key}.${nonce}`)}">${esc(a.email)}</a> — ${esc(a.note)}</li>`)
    .join("");
  return new Response(`<!doctype html><meta charset="utf-8"><title>Fake Google</title><body style="font-family:system-ui;margin:3rem"><h1>Fake Google (preview only)</h1><p>Choose an account:</p><ul>${rows}</ul><p><a href="/oauth/google/callback?state=${encodeURIComponent(state)}&amp;error=access_denied">Cancel</a></p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__fake-google") return picker(url);
    const res = await door(req);
    const location = res.headers.get("location");
    if (location?.startsWith("https://accounts.google.com/")) {
      const to = new URL(location);
      const headers = new Headers(res.headers);
      headers.set("Location", `${origin}/__fake-google?${to.searchParams}`);
      return new Response(null, { status: res.status, headers });
    }
    return res;
  },
});

// A registered client and a ready-made authorization request, so the sign-in
// and consent pages are one click away (approving returns to a dead port).
const registered = (await (await door(new Request(`${origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) }))).json()) as { client_id: string };
const authorizeUrl = `${origin}/authorize?${new URLSearchParams({ client_id: registered.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", state: "preview", scope: "read", resource: `${origin}/mcp` })}`;

console.log(`connector preview on ${origin} (scratch data in ${dir})
  join page:        ${origin}/join   → "Sign in with Google" → pick an account
  personal page:    ${origin}/me     (after signing in as ada@example.com or grace@example.com)
  not-a-member:     sign in as stranger@example.net
  sign-in/consent:  ${authorizeUrl}
                    (Allow redirects to claude.ai with a code nothing will redeem — harmless)
  owner credential: ${owner.token}
Ctrl-C to stop.`);
process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
