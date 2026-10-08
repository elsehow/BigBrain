/** oauthSignIn.ts — a person signs in to a provider in their own browser, and
 * BigBrain keeps the sign-in. Both browser sign-ins run on it: Granola through
 * its MCP transport (discovery, dynamic registration and PKCE inside the SDK's
 * auth provider, lib/granolaMcp.ts), Hardcover through the SDK's standalone
 * helpers with a fixed public client (lib/hardcover.ts).
 *
 * The flow: a one-shot callback on 127.0.0.1 at a port the system picks (the
 * loopback redirect of RFC 8252), a `state` only this flow knows, the `iss`
 * the answer names checked against the issuer asked (RFC 9207) when the
 * provider sends one, and ten minutes before it gives up. One flow per
 * provider and account; starting another cancels the first.
 *
 * What it keeps: one private file per account (0600 in a 0700 directory,
 * replaced whole), and a lock beside it that every BigBrain process takes
 * before it refreshes, so a rotating refresh token is spent once. */
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { discoverAuthorizationServerMetadata, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { writeAtomic } from "./fsx";
import { withHeldLock } from "./sqliteLock";

/** An account's kept sign-in, or undefined when it has none or it can't be read. */
export function readSignIn<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}
/** Replace an account's kept sign-in: private, and whole or not at all. */
export function saveSignIn(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, JSON.stringify(value) + "\n", 0o600);
}

/** Run `fn` holding an account's refresh lock: a private SQLite file every
 * BigBrain process honors (the web process, pollers, each MCP client's
 * server), released the moment its holder dies, and waited for without ever
 * blocking this process's event loop (lib/sqliteLock.ts). */
export const withSignInLock = withHeldLock;

export type SignInPhase = "starting" | "browser" | "connected" | "error" | "cancelled";
export interface SignInStatus { phase: SignInPhase; url?: string; error?: string }

/** What one provider's browser sign-in does at each step. */
export interface LoopbackSignIn {
  /** The provider as the person calls it, for the words they read: "Granola". */
  name: string;
  /** When set, the answer's `iss` must be exactly this, or it is refused and the flow ends. */
  issuer?: string;
  /** The URL that sends the person to the provider, for this redirect URI and state. Whatever it saves, `abandon` withdraws. */
  begin(redirect: string, state: string): Promise<URL>;
  /** Redeem the code and keep the sign-in. Throws to refuse it; keeps nothing then. */
  finish(code: string): Promise<void>;
  /** The flow was cancelled or timed out before connecting: withdraw what `begin` saved. */
  abandon(): void;
  /** Release whatever begin or finish opened, once the flow ends either way. */
  close?(): Promise<void>;
}

interface Flow extends SignInStatus { cancel: () => void }
const flows = new Map<string, Flow>();
const flowKey = (provider: string, root: string, account: string) => provider + "\n" + root + "\n" + account;

export function signInStatus(provider: string, root: string, account: string): SignInStatus | undefined {
  const f = flows.get(flowKey(provider, root, account));
  return f ? { phase: f.phase, url: f.url, error: f.error } : undefined;
}
export function cancelSignIn(provider: string, root: string, account: string): void {
  flows.get(flowKey(provider, root, account))?.cancel();
}

/** Start a browser sign-in: listens on loopback, returns the URL for the app to
 * open. `onConnected` runs once `finish` has kept the sign-in. */
export async function startLoopbackSignIn(provider: string, root: string, account: string, onConnected: () => void, s: LoopbackSignIn): Promise<SignInStatus> {
  const key = flowKey(provider, root, account);
  flows.get(key)?.cancel();
  const state = crypto.randomUUID();
  let redirect = "", timer: ReturnType<typeof setTimeout> | undefined, active = true;
  const cleanup = () => { if (timer) clearTimeout(timer); server.close(); void s.close?.().catch(() => {}); };
  const flow: Flow = { phase: "starting", cancel: () => {
    if (["connected", "cancelled", "error"].includes(flow.phase)) return;
    active = false; flow.phase = "cancelled"; delete flow.url; cleanup(); s.abandon();
  } };
  flows.set(key, flow);
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", redirect);
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (req.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state || !active) { res.writeHead(400); res.end("Invalid or expired sign-in."); return; }
    active = false; delete flow.url;
    try {
      // a code another server minted is never redeemed here (RFC 9207 mix-up defense)
      if (s.issuer !== undefined && url.searchParams.get("iss") !== s.issuer) throw Error(`That sign-in answer did not come from ${s.name}. Try again.`);
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) throw Error(`${s.name} sign-in was cancelled.`);
      await s.finish(code);
      onConnected(); flow.phase = "connected"; res.end(`${s.name} connected. Return to BigBrain.`);
    } catch (e) {
      flow.phase = "error"; flow.error = e instanceof Error ? e.message : `${s.name} sign-in failed.`;
      res.writeHead(400); res.end(`Could not connect ${s.name}. Return to BigBrain and try again.`);
    } finally { cleanup(); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Could not start sign-in.");
    redirect = `http://127.0.0.1:${address.port}/callback`;
    flow.url = (await s.begin(redirect, state)).toString(); flow.phase = "browser";
    timer = setTimeout(() => flow.cancel(), 10 * 60_000); timer.unref?.();
    return signInStatus(provider, root, account)!;
  } catch (e) {
    flow.cancel(); flow.phase = "error"; flow.error = e instanceof Error ? e.message : `Could not start ${s.name} sign-in.`;
    throw Error(flow.error);
  }
}

// ── a fixed public client, through the SDK's standalone helpers ────────────

/** `issuer`'s authorization server as its discovery document describes it, only
 * when the document names that issuer (RFC 8414 §3.3) and offers PKCE S256. */
export async function discoverIssuer(issuer: string, fetchFn: FetchLike): Promise<AuthorizationServerMetadata> {
  const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
  if (!metadata || metadata.issuer !== issuer) throw Error("The sign-in server did not identify itself. Try again later.");
  if (!metadata.code_challenge_methods_supported?.includes("S256")) throw Error("The sign-in server does not offer PKCE.");
  return metadata;
}

/** A granted scope that holds anything beyond reading: `all`, any `write:*`, or a scope this doesn't know as a read. */
export const beyondRead = (scope: string | undefined): boolean => !!scope?.split(/\s+/).some(s => s && !s.startsWith("read:"));

/** Failures where the request never left this machine: nothing was sent, so nothing was spent. */
const UNSENT = new Set(["ConnectionRefused", "FailedToOpenSocket", "UnableToConnect", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
export const neverSent = (error: unknown): boolean => UNSENT.has(String((error as { code?: unknown } | null)?.code ?? ""));

export type Redeemed = { ok: true; tokens: OAuthTokens } | { ok: false; spent: boolean };
/** Redeem a rotating refresh token once. `spend` must keep the credential
 * without it before it is sent, so no retry, crash or second process ever
 * sends it again (the provider revokes the whole chain on reuse); it comes back
 * only when the request provably never left. The tokens returned never repeat
 * the spent refresh token: no new one means none. */
export async function redeemRefreshToken(issuer: string, o: { metadata: AuthorizationServerMetadata; clientId: string; refreshToken: string; fetchFn: FetchLike; spend: () => void }): Promise<Redeemed> {
  o.spend();
  try {
    const tokens = await refreshAuthorization(issuer, { metadata: o.metadata, clientInformation: { client_id: o.clientId }, refreshToken: o.refreshToken, fetchFn: o.fetchFn });
    const { refresh_token: next, ...rest } = tokens;
    return { ok: true, tokens: next && next !== o.refreshToken ? { ...rest, refresh_token: next } : rest };
  } catch (error) { return { ok: false, spent: !neverSent(error) }; }
}

/** Fetch with a deadline, a size cap on what comes back and BigBrain's User-Agent; for the SDK's helpers and plain calls alike. */
export function boundedFetch(o: { timeoutMs: number; maxBytes: number; userAgent: string }): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", o.userAgent);
    const signal = AbortSignal.any([AbortSignal.timeout(o.timeoutMs), ...(init?.signal ? [init.signal] : [])]);
    const response = await fetch(input, { ...init, headers, signal, redirect: "error" });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > o.maxBytes) { await response.body?.cancel(); throw new SizeError(); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > o.maxBytes) throw new SizeError();
      chunks.push(chunk);
    }
    // the body is already decoded: its old length and encoding no longer describe it
    const kept = new Headers(response.headers);
    kept.delete("content-encoding"); kept.delete("content-length");
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: kept });
  };
}
export class SizeError extends Error { constructor() { super("The answer was larger than BigBrain reads."); } }
