/**
 * auth.ts — drop tokens: the vault's capability credentials for HTTP
 * intake. A token is `bb_<id>_<secret>`: the id is a public, log-friendly
 * record key; the secret is never stored — only sha256(full token) is kept
 * at rest, so a leaked store file mints nothing.
 *
 * The model is fail-closed everywhere: a missing, empty, or unreadable
 * store verifies nobody. Scopes are exact strings (`inbox:write`;
 * `vault:read` — the web read path for non-browser API clients; `tend` — the
 * gardener door's claim + submit, #479, held by ONE designated machine per
 * vault) — no wildcards, no hierarchy. (`outbox:write` retired with email,
 * 2026-08-10.)
 *
 * A credential that can read the vault (`vault:read`, without `tend`)
 * lapses after IDLE_EXPIRY_DAYS unused, counted from its last use (or its
 * minting, or its last renewal). There is no absolute cap: use keeps it
 * alive, and renewing restarts the clock without changing the id. Pairing
 * credentials (`inbox:write` only) and the gardener's `tend` never lapse.
 *
 * Stores live OUTSIDE the vault (like the vault pointer): the vault's
 * .state/ is a cache that may be deleted freely,
 * and a credential store is truth, not cache. Host-side stores are keyed
 * by vault-root hash because one machine can host several vaults and a
 * token for vault A must not authorize writes to vault B.
 *
 * Every function takes the store path explicitly so tests run against
 * temp dirs — nothing here touches VAULT_ROOT (which resolves at import
 * time in lib/manifest.ts).
 */

import { clientTokenStore, tokenStore } from "./env";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { join } from "node:path";
import { sha256hex } from "./hash";
import { configDir } from "./engine";
import { writeAtomic } from "./fsx";

export interface TokenRecord {
  /** 8 hex chars — public identifier, safe to log. */
  id: string;
  /** Human label chosen at mint time ("chrome extension", "laptop"). */
  name: string;
  /** The person this credential belongs to (an email) — the verified
   * identity intake stamps as `from:` on person-kind drops. Absent on
   * legacy tokens: those stamp no principal and items fall back to the
   * channel heuristic. */
  owner?: string;
  /** What holds the credential: a person's device (default) or an agent
   * acting as the owner's delegate. Agent tokens stamp `from:` with the
   * AGENT's name — identity a person can never claim, and vice versa. */
  kind?: "person-device" | "agent";
  /** Which mint path produced this credential — its PROVENANCE, a different
   * question from `kind`'s "what principal does it write as".
   *
   * A closed union rather than a free string:
   * `client` is an authenticated MCP configuration;
   * `connect` is the legacy local Claude Code (the agents card), `pair` is a
   * browser extension that redeemed a pairing code (the integrations card,
   * lib/pair.ts). Each card is a CONSENT surface, so the one thing it has to
   * be able to prove is that a human authorized this credential on that
   * card. Absent means "we cannot say", and the cards show nothing they
   * cannot name — which is what keeps a credential minted for some unrelated
   * internal reason from appearing as a machine the user connected.
   *
   * That failure was real (#141): the pre-#96 `web shell` token was minted
   * `kind: agent` — correctly, since it must never write as the person — and
   * the tab read it as a connected laptop on a vault nobody had connected to. */
  via?: "connect" | "pair" | "client";
  scopes: string[];
  /** hex sha256 of the full `bb_<id>_<secret>` string. */
  sha256: string;
  created: string;
  last_used: string | null;
  /** When a person last renewed it: restarts the idle clock without
   * claiming a use. Absent on credentials never renewed. */
  renewed?: string | null;
  /** The last time it was presented after it lapsed — what the app's
   * notice reports. Renewing, or clearing the notice, resets it. */
  expired_use?: string | null;
  /** Revocation timestamp; the record stays for audit. */
  revoked: string | null;
}

interface TokenStore {
  version: 1;
  /** The vault this store authorizes — informational; the filename hash is the key. */
  vault: string;
  tokens: TokenRecord[];
}

/** `expired` is set only for a credential that matched and was not revoked —
 * its holder, not a guesser, is the one told that it lapsed. */
export type VerifyResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: string; expired?: TokenRecord };

const TOKEN_RE = /^bb_([0-9a-f]{8})_[A-Za-z0-9_-]+$/;

/** Host-side store path for a vault: ~/.config/bigbrain/tokens/<hash>.json,
 * overridable via BIGBRAIN_TOKENS (tests, exotic layouts). */
export function tokenStorePath(vaultRoot: string): string {
  const env = tokenStore();
  if (env) return env;
  return join(configDir(), "tokens", `${sha256hex(vaultRoot).slice(0, 12)}.json`);
}

function readStore(storePath: string): TokenStore | undefined {
  if (!existsSync(storePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    if (!Array.isArray(raw?.tokens)) return undefined;
    return raw as TokenStore;
  } catch {
    return undefined;
  }
}

function writeStore(storePath: string, store: TokenStore): void {
  writeAtomic(storePath, JSON.stringify(store, null, 2) + "\n", 0o600);
}

/** Mint a new token. The ONLY function that ever sees the plaintext secret;
 * the caller prints it once and it is gone. */
export function mintToken(
  storePath: string,
  vaultRoot: string,
  name: string,
  scopes: string[],
  identity?: { owner?: string; kind?: "person-device" | "agent"; via?: TokenRecord["via"] }
): { token: string; record: TokenRecord } {
  const id = randomBytes(4).toString("hex");
  const token = `bb_${id}_${randomBytes(32).toString("base64url")}`;
  const record: TokenRecord = {
    id,
    name,
    ...(identity?.owner ? { owner: identity.owner } : {}),
    ...(identity?.kind ? { kind: identity.kind } : {}),
    ...(identity?.via ? { via: identity.via } : {}),
    scopes,
    sha256: sha256hex(token),
    created: new Date().toISOString(),
    last_used: null,
    revoked: null,
  };
  const store = readStore(storePath) ?? { version: 1 as const, vault: vaultRoot, tokens: [] };
  store.tokens.push(record);
  writeStore(storePath, store);
  return { token, record };
}

// A fixed digest to compare against when the presented id matches no
// record — the work done is the same either way, so timing doesn't
// distinguish "unknown id" from "wrong secret".
const DUMMY_DIGEST = Buffer.from(sha256hex("bigbrain-dummy"), "hex");

/** Verify a presented token. Fail-closed: missing store, unparseable
 * store, empty token list, malformed token, unknown id, revoked, or hash
 * mismatch all refuse. `reason` is for the SERVER LOG only — callers must
 * answer the wire with an undifferentiated 401. */
export function verifyToken(storePath: string, presented: string, now: Date = new Date()): VerifyResult {
  const store = readStore(storePath);
  if (!store) return { ok: false, reason: "token store missing or unreadable" };
  if (!store.tokens.length) return { ok: false, reason: "token store is empty" };

  const m = TOKEN_RE.exec(presented);
  const record = m ? store.tokens.find((t) => t.id === m[1]) : undefined;
  const expected = record ? Buffer.from(record.sha256, "hex") : DUMMY_DIGEST;
  const actual = createHash("sha256").update(presented).digest();
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!m) return { ok: false, reason: "malformed token" };
  if (!record) return { ok: false, reason: `unknown token id ${m[1]}` };
  if (!match) return { ok: false, reason: `secret mismatch for token ${record.id}` };
  if (record.revoked)
    return { ok: false, reason: `token ${record.id} revoked at ${record.revoked}` };
  if (tokenExpired(record, now))
    return { ok: false, reason: `token ${record.id} expired after ${IDLE_EXPIRY_DAYS} days unused`, expired: record };
  return { ok: true, record };
}

export function hasScope(record: TokenRecord, scope: string): boolean {
  return record.scopes.includes(scope);
}

export const IDLE_EXPIRY_DAYS = 30;

/** What the holder of a lapsed credential is told: where to renew it. A
 * connected client renews in the app; anything else is an operator's. */
export const expiredMessage = (record: TokenRecord): string =>
  record.via === "client"
    ? `This BigBrain connection expired after ${IDLE_EXPIRY_DAYS} days unused. Renew it in BigBrain → Settings → Connected clients.`
    : `This BigBrain credential expired after ${IDLE_EXPIRY_DAYS} days unused. Renew it with \`bigbrain auth renew ${record.id}\`.`;

/** Reads the vault and is not the gardener's: the credentials that lapse. */
export const expiresWhenIdle = (record: TokenRecord): boolean =>
  hasScope(record, "vault:read") && !hasScope(record, "tend");

/** Lapsed: unused (and unrenewed) for IDLE_EXPIRY_DAYS. Fail-closed — a
 * record with no readable timestamp counts as lapsed. */
export function tokenExpired(record: TokenRecord, now: Date = new Date()): boolean {
  if (!expiresWhenIdle(record)) return false;
  const since = Math.max(
    ...[record.created, record.last_used, record.renewed].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite)
  );
  return now.getTime() - since >= IDLE_EXPIRY_DAYS * 86_400_000;
}

export function listTokens(storePath: string): TokenRecord[] {
  return readStore(storePath)?.tokens ?? [];
}

/** Revoke by id. Returns false when no such token exists. The record is
 * kept (timestamped) so `token list` remains an audit trail. */
export function revokeToken(storePath: string, id: string): boolean {
  const store = readStore(storePath);
  const record = store?.tokens.find((t) => t.id === id);
  if (!store || !record) return false;
  record.revoked ??= new Date().toISOString();
  writeStore(storePath, store);
  return true;
}

/** Restart a credential's idle clock, keeping its id — and with it every
 * grant keyed to that id. A revoked credential stays revoked. */
export function renewToken(storePath: string, id: string, now: Date = new Date()): boolean {
  const store = readStore(storePath);
  const record = store?.tokens.find((t) => t.id === id);
  if (!store || !record || record.revoked) return false;
  record.renewed = now.toISOString();
  record.expired_use = null;
  writeStore(storePath, store);
  return true;
}

/** Note that a lapsed credential was presented, so the app can say so.
 * Throttled like touchLastUsed. Writes only while it is still lapsed. */
export function noteExpiredUse(storePath: string, id: string, now: Date = new Date()): void {
  const store = readStore(storePath);
  const record = store?.tokens.find((t) => t.id === id);
  if (!store || !record || record.revoked || !tokenExpired(record, now)) return;
  if (record.expired_use && now.getTime() - Date.parse(record.expired_use) < 60_000) return;
  record.expired_use = now.toISOString();
  writeStore(storePath, store);
}

/** Forget a lapsed credential's last attempt: the notice clears until the
 * next one. */
export function clearExpiredUse(storePath: string, id: string): boolean {
  const store = readStore(storePath);
  const record = store?.tokens.find((t) => t.id === id);
  if (!store || !record) return false;
  if (record.expired_use) {
    record.expired_use = null;
    writeStore(storePath, store);
  }
  return true;
}

/** Record a use. Re-reads the store fresh so a revocation that landed
 * between verify and touch is never overwritten with stale state; the
 * worst concurrent-write outcome is a lost timestamp tick. Throttled:
 * a tick younger than 60s is not worth a write per request. */
export function touchLastUsed(storePath: string, id: string, now: Date = new Date()): void {
  const store = readStore(storePath);
  const record = store?.tokens.find((t) => t.id === id);
  if (!store || !record) return;
  if (record.last_used && now.getTime() - Date.parse(record.last_used) < 60_000) return;
  record.last_used = now.toISOString();
  writeStore(storePath, store);
}

// ---------------------------------------------------------------------------
// Client side: where a limb that ships over HTTP (the Claude Code plugin)
// keeps the one token it was handed. Keyed by API base url — a machine can
// talk to several vaults. `bigbrain connect` is the writer; the plugin's
// bb.sh reads the file itself, in POSIX sh, so nothing in TypeScript reads
// it back (a reader went with `bigbrain mcp --host` on 2026-08-30).

export function clientTokensPath(agent: "claude" | "codex" = "claude"): string {
  return clientTokenStore() ?? join(configDir(), agent === "codex" ? "client-tokens-codex.json" : "client-tokens.json");
}

interface ClientTokenEntry {
  token: string;
  name: string;
  saved: string;
}

function readClientTokens(path: string): Record<string, ClientTokenEntry> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function saveClientToken(
  url: string,
  token: string,
  name: string,
  path: string = clientTokensPath()
): void {
  const all = readClientTokens(path);
  all[url] = { token, name, saved: new Date().toISOString() };
  writeAtomic(path, JSON.stringify(all, null, 2) + "\n", 0o600);
}
