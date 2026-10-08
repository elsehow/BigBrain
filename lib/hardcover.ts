/** hardcover.ts — the person's Hardcover library and the Hardcover catalog
 * (hardcover.app), looked up on their behalf. Lookup only: BigBrain never
 * changes anything on Hardcover and never polls it.
 *
 * Sign-in is OAuth with PKCE in the person's browser (lib/oauthSignIn.ts),
 * through BigBrain's fixed public client, asking for read scopes only; a grant
 * that comes back with more is refused and kept nowhere. Access tokens last a
 * week. Refresh tokens rotate on every use and Hardcover revokes the whole
 * chain when one is used twice, so a refresh is spent once, under a lock every
 * BigBrain process takes, and `me` is checked against the person who signed in
 * after each one. A chain that can't be renewed leaves the account connected
 * but lapsed: every read says how to reconnect.
 *
 * Every read is a fixed GraphQL document with one top-level field (each costs
 * one request of Hardcover's limits), sent under a budget per account that
 * every BigBrain process shares (lib/requestLimit.ts), below Hardcover's own.
 * Nothing is retried after Hardcover refuses or times out. */
import { join } from "node:path";
import { exchangeAuthorization, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { engineIdentity } from "./engine";
import { sha256hex } from "./hash";
import { loadManifest } from "./manifest";
import { beyondRead, boundedFetch, cancelSignIn, discoverIssuer, readSignIn, redeemRefreshToken, saveSignIn, signInStatus, SizeError, startLoopbackSignIn, withSignInLock, type SignInStatus } from "./oauthSignIn";
import { LimitError, takeRequest, type RequestLimits } from "./requestLimit";

export const HARDCOVER_ISSUER = "https://api.hardcover.app";
export const HARDCOVER_GRAPHQL = "https://api.hardcover.app/v1/graphql";
/** Stands in for BigBrain's client id until BigBrain is registered on Hardcover. */
export const HARDCOVER_CLIENT_ID_PLACEHOLDER = "unregistered-bigbrain-client-id";
/** BigBrain's public OAuth client on Hardcover (an app of type "Mobile, desktop,
 * or CLI"). A PLACEHOLDER until that registration exists; meanwhile a vault
 * signs in with its own, `integrations.hardcover.clientId` in vault.yaml. */
export const HARDCOVER_CLIENT_ID: string = HARDCOVER_CLIENT_ID_PLACEHOLDER;
/** Exactly what BigBrain asks for: who you are, your library, and the catalog. */
export const HARDCOVER_SCOPES = "read:me:content read:library read:catalog:search read:catalog:data";
export const HARDCOVER_RECONNECT = "Hardcover needs reconnecting: BigBrain → Settings → Integrations.";
const REFUSED = "Hardcover refused or timed out. Try again later.";
const UNEXPECTED = "Hardcover answered in a shape BigBrain doesn't recognize.";
const CHANGED = "Hardcover connection changed. Try again.";
const TOO_BROAD = "Hardcover granted more than read access; reconnect.";
/** Below Hardcover's free plan (burst 10, 60 a minute, 5,000 a day), which every app the person uses shares. */
const LIMITS = { burst: 5, perMinute: 30, daily: 4_000 };
const MAX_BYTES = 1_000_000;
/** An access token this close to expiring is renewed before it is used. */
const RENEW_BEFORE = 10 * 60_000;

/** Test seams: a stand-in for Hardcover's API and its sign-in server, and the budget in place of BigBrain's. */
export interface HardcoverOptions { endpoint?: string; issuer?: string; timeoutMs?: number; limits?: RequestLimits }
type Call = HardcoverOptions & { signal?: AbortSignal };

interface Tokens { access: string; refresh?: string; expiresAt: number; scope?: string }
export interface HardcoverUser { id: number; username: string | null }
interface Credential {
  /** New at every connect and disconnect, never at a refresh: policies are checked against it. */
  generation: string;
  connected: boolean;
  /** The client the tokens were issued to; they renew only with it. */
  clientId?: string;
  tokens?: Tokens;
  /** Who signed in, as `me` said then; every refresh must say the same. */
  user?: HardcoverUser;
  /** A refreshed token whose `me` is still to be checked. */
  unverified?: true;
  /** The refresh chain is gone; only signing in again restores it. */
  lapsed?: true;
}
type Live = Credential & { clientId: string; tokens: Tokens; user: HardcoverUser };

const dir = (root: string) => join(root, ".spool", "integration-oauth", "hardcover");
const file = (root: string, account: string) => join(dir(root), sha256hex(account) + ".json");
const budget = (root: string, account: string) => join(dir(root), sha256hex(account) + ".budget.json");
const read = (root: string, account: string) => readSignIn<Credential>(file(root, account));
const save = (root: string, account: string, c: Credential) => saveSignIn(file(root, account), c);

/** The account's sign-in as Settings and policies see it, or undefined when it has none. `lapsed`: kept, but no longer renewable. */
export function hardcoverConnection(root: string, account: string): { generation: string; identity?: HardcoverUser; lapsed: boolean } | undefined {
  const c = read(root, account);
  return c?.connected ? { generation: c.generation, ...(c.user ? { identity: c.user } : {}), lapsed: !!c.lapsed || !c.tokens } : undefined;
}
export function disconnectHardcover(root: string, account: string): void {
  cancelSignIn("hardcover", root, account);
  save(root, account, { generation: crypto.randomUUID(), connected: false });
}
export const hardcoverSignInStatus = (root: string, account: string): SignInStatus | undefined => signInStatus("hardcover", root, account);
export const cancelHardcoverSignIn = (root: string, account: string): void => cancelSignIn("hardcover", root, account);

/** The client this vault signs in with, its own from vault.yaml else BigBrain's, or why there is none. */
function client(root: string): { id: string } | { unavailable: string } {
  const own = loadManifest(root).integrations["hardcover"]?.["clientId"];
  if (own !== undefined) return typeof own === "string" && /^[\w.~-]{1,200}$/.test(own) ? { id: own } : { unavailable: "integrations.hardcover.clientId in vault.yaml is not a client id." };
  return HARDCOVER_CLIENT_ID === HARDCOVER_CLIENT_ID_PLACEHOLDER
    ? { unavailable: "Hardcover sign-in isn't available in this build yet. To sign in with your own Hardcover app, set integrations.hardcover.clientId in vault.yaml (docs/hardcover.md)." }
    : { id: HARDCOVER_CLIENT_ID };
}
export function hardcoverClientId(root: string): string {
  const c = client(root);
  if ("unavailable" in c) throw Error(c.unavailable);
  return c.id;
}
/** Why this vault can't sign in to Hardcover yet, as the library and Settings say it; undefined when it can. */
export function hardcoverSignInUnavailable(root: string): string | undefined {
  const c = client(root);
  return "unavailable" in c ? c.unavailable : undefined;
}

const userAgent = () => `BigBrain/${/^engine (\S+)/.exec(engineIdentity().bundle ?? "")?.[1] ?? "dev"} (+https://bigbrain.cool)`;
const fetcher = (o: HardcoverOptions): FetchLike => boundedFetch({ timeoutMs: o.timeoutMs ?? 30_000, maxBytes: MAX_BYTES, userAgent: userAgent() });
const kept = (t: OAuthTokens): Tokens => ({ access: t.access_token, ...(t.refresh_token ? { refresh: t.refresh_token } : {}),
  expiresAt: Date.now() + (t.expires_in ?? 7 * 86_400) * 1000, ...(t.scope ? { scope: t.scope } : {}) });

/** A fixed query: its operation name, its text, and the shape its `data` must have. */
export interface HardcoverDocument<T> { operationName: string; query: string; data: z.ZodType<T> }
const ME: HardcoverDocument<{ me: { id: number; username: string | null }[] }> = {
  operationName: "BigBrainMe", query: "query BigBrainMe { me { id username } }",
  data: z.object({ me: z.array(z.object({ id: z.int().positive(), username: z.string().nullable() })) }),
};

/** One request to Hardcover's API; `ok: false` when it no longer honors the token. Errors say what happened, never what was sent. */
async function post<T>(root: string, account: string, token: string, doc: HardcoverDocument<T>, variables: Record<string, unknown>, o: Call): Promise<{ ok: true; data: T } | { ok: false }> {
  try { await takeRequest(budget(root, account), o.limits ?? LIMITS, { signal: o.signal }); }
  catch (e) {
    if (!(e instanceof LimitError)) throw e;
    throw Error(e.reason === "daily" ? "BigBrain's Hardcover lookups for today are used up; they resume after midnight UTC." : "Hardcover lookups are coming too fast. Try again in a minute.");
  }
  let response: Response;
  try {
    response = await fetcher(o)(o.endpoint ?? HARDCOVER_GRAPHQL, { method: "POST", signal: o.signal,
      headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: doc.query, variables, operationName: doc.operationName }) });
  } catch (e) {
    o.signal?.throwIfAborted();
    throw Error(e instanceof SizeError ? "Hardcover sent more than BigBrain reads at once." : REFUSED);
  }
  if (response.status === 401) return { ok: false };
  if (response.status === 403) throw Error("Hardcover refused this request.");
  if (response.status === 408 || response.status === 429) throw Error(REFUSED);
  if (!response.ok) throw Error("Hardcover is unavailable right now. Try again later.");
  let body: { data?: unknown; errors?: unknown } | null;
  try { body = await response.json() as typeof body; } catch { throw Error(UNEXPECTED); }
  if (body?.errors !== undefined) throw Error("Hardcover could not answer that request.");
  const parsed = doc.data.safeParse(body?.data);
  if (!parsed.success) throw Error(UNEXPECTED);
  return { ok: true, data: parsed.data };
}

function usable(c: Credential | undefined): Live {
  if (!c?.connected) throw Error("Connect Hardcover in Settings → Integrations.");
  if (c.lapsed || !c.tokens || !c.user || !c.clientId) throw Error(HARDCOVER_RECONNECT);
  return c as Live;
}
/** The account can no longer renew: it stays connected, and every read says how to reconnect. */
function lapse(root: string, account: string, generation: string): Error {
  const c = read(root, account);
  if (c?.generation === generation) { const { tokens: _spent, unverified: _u, ...rest } = c; save(root, account, { ...rest, lapsed: true }); }
  return Error(HARDCOVER_RECONNECT);
}

/** Renew the account's access under the refresh lock: refresh if `stale` is
 * still the token on file (another process may have just done it), then check
 * that `me` is still the person who signed in. */
function renew(root: string, account: string, stale: string, o: Call): Promise<Live> {
  const issuer = o.issuer ?? HARDCOVER_ISSUER, fetchFn = fetcher(o);
  return withSignInLock(file(root, account) + ".lock", async () => {
    let c = usable(read(root, account));
    const generation = c.generation;
    const keep = (next: Credential) => { if (read(root, account)?.generation !== generation) throw Error(CHANGED); save(root, account, next); };
    if (c.tokens.access === stale) {
      const { refresh, ...unspent } = c.tokens;
      if (!refresh) throw lapse(root, account, generation);
      let metadata: AuthorizationServerMetadata;
      try { metadata = await discoverIssuer(issuer, fetchFn); } catch { throw Error(REFUSED); }
      const redeemed = await redeemRefreshToken(issuer, { metadata, clientId: c.clientId, refreshToken: refresh, fetchFn, spend: () => keep({ ...c, tokens: unspent }) });
      if (!redeemed.ok) {
        if (redeemed.spent) throw lapse(root, account, generation);
        keep(c); // it never left this machine
        throw Error(REFUSED);
      }
      if (beyondRead(redeemed.tokens.scope)) { disconnectHardcover(root, account); throw Error(TOO_BROAD); }
      c = { ...c, tokens: kept(redeemed.tokens), unverified: true };
      keep(c);
    }
    if (c.unverified) {
      const answer = await post(root, account, c.tokens.access, ME, {}, o);
      if (!answer.ok) throw lapse(root, account, generation);
      if (answer.data.me.length !== 1 || answer.data.me[0]!.id !== c.user.id) {
        disconnectHardcover(root, account);
        throw Error("Hardcover is signed in as someone else now. Reconnect it in Settings → Integrations.");
      }
      const { unverified: _checked, ...verified } = c;
      c = verified;
      keep(c);
    }
    return c;
  }, { busy: "Hardcover is busy. Try again.", signal: o.signal });
}

/** One fixed read on the account's behalf, its answer checked against
 * `doc.data`. An expiring sign-in is renewed first, and a token Hardcover
 * stops honoring is renewed once; neither retries a refused read. */
export async function hardcoverRead<T>(root: string, account: string, doc: HardcoverDocument<T>, variables: (user: HardcoverUser) => Record<string, unknown>, o: Call = {}): Promise<T> {
  let c = usable(read(root, account));
  if (c.unverified || c.tokens.expiresAt - Date.now() < RENEW_BEFORE) c = await renew(root, account, c.tokens.access, o);
  let answer = await post(root, account, c.tokens.access, doc, variables(c.user), o);
  if (!answer.ok) {
    c = await renew(root, account, c.tokens.access, o);
    answer = await post(root, account, c.tokens.access, doc, variables(c.user), o);
    if (!answer.ok) throw lapse(root, account, c.generation);
  }
  if (read(root, account)?.generation !== c.generation) throw Error(CHANGED);
  return answer.data;
}

/** Best effort: a grant BigBrain refuses shouldn't outlive the refusal. */
async function revoke(metadata: AuthorizationServerMetadata, clientId: string, tokens: OAuthTokens, fetchFn: FetchLike): Promise<void> {
  const endpoint = "revocation_endpoint" in metadata ? metadata.revocation_endpoint : undefined;
  if (typeof endpoint !== "string") return;
  for (const [token, hint] of [[tokens.refresh_token, "refresh_token"], [tokens.access_token, "access_token"]] as const) {
    if (token) await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }) }).catch(() => undefined);
  }
}

/** Start the browser sign-in: returns the URL for the app to open. `onConnected` runs once the sign-in is verified and kept. */
export async function startHardcoverSignIn(root: string, account: string, onConnected: () => void, o: HardcoverOptions = {}): Promise<SignInStatus> {
  const issuer = o.issuer ?? HARDCOVER_ISSUER, clientId = hardcoverClientId(root), fetchFn = fetcher(o);
  const generation = crypto.randomUUID();
  let metadata: AuthorizationServerMetadata, verifier = "", redirectUri = "";
  return startLoopbackSignIn("hardcover", root, account, onConnected, {
    name: "Hardcover", issuer,
    begin: async (redirect, state) => {
      metadata = await discoverIssuer(issuer, fetchFn);
      save(root, account, { generation, connected: false });
      redirectUri = redirect;
      const started = await startAuthorization(issuer, { metadata, clientInformation: { client_id: clientId }, redirectUrl: redirect, scope: HARDCOVER_SCOPES, state });
      verifier = started.codeVerifier;
      return started.authorizationUrl;
    },
    finish: async code => {
      let tokens: OAuthTokens;
      try { tokens = await exchangeAuthorization(issuer, { metadata, clientInformation: { client_id: clientId }, authorizationCode: code, codeVerifier: verifier, redirectUri, fetchFn }); }
      catch { throw Error("Hardcover did not accept the sign-in. Try again."); }
      if (beyondRead(tokens.scope)) { await revoke(metadata, clientId, tokens, fetchFn); throw Error(TOO_BROAD); }
      const answer = await post(root, account, tokens.access_token, ME, {}, o);
      const user = answer.ok && answer.data.me.length === 1 ? answer.data.me[0]! : undefined;
      if (!user) throw Error("Hardcover did not say who signed in. Try again.");
      if (read(root, account)?.generation !== generation) throw Error(CHANGED);
      save(root, account, { generation, connected: true, clientId, tokens: kept(tokens), user: { id: user.id, username: user.username } });
    },
    abandon: () => { if (read(root, account)?.generation === generation) save(root, account, { generation: crypto.randomUUID(), connected: false }); },
  });
}
