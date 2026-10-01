import {withMemberLock} from './sharedMemberLock';
/**
 * sharedMembers.ts — who may reach a SHARED vault, and with what.
 *
 * A shared vault (docs/shared-vault.md) is one authoritative vault that
 * several people write to. Its trust model has two layers, and this module
 * is both:
 *
 *   MEMBER      a stable identity in the record — the `author.id` every
 *               event carries. One owner (the vault's operator, who also
 *               moderates) and any number of members, each with a
 *               permission set (`read`, `write`). A handle is immutable and
 *               never reused, because the record cites it forever.
 *   CREDENTIAL  a bearer secret `sv_<id>_<secret>` that PROVES a member is
 *               asking. A member may hold several (a laptop, a phone, an
 *               agent acting as their delegate); each carries scopes that
 *               can only be a subset of the member's permissions, and the
 *               effective permission of a request is the intersection,
 *               recomputed on every request — narrowing a member narrows
 *               every credential they hold, immediately.
 *
 * The actor of a request is DERIVED from the credential, never read from
 * the request: `lib/sharedVaultApi.ts` refuses a body that tries to name
 * one. An `agent` credential writes as `{kind: "agent", id: <handle>}` — the
 * member it was minted for, framed as their delegate — and a person
 * credential as `{kind: "user", id: <handle>}`; neither can claim the other.
 *
 * Same discipline as lib/auth.ts: only sha256(secret) is stored, the store
 * lives outside the vault (a vault's tree is content, not credentials),
 * comparison is timing-safe, and everything fails closed — no store, an
 * unreadable store, an unknown id, a wrong secret, a revoked credential or
 * a revoked member all verify nobody. Every function takes the store path
 * explicitly so tests and the smoke scenario run against scratch files.
 *
 * Membership mutations take a cross-process lock shared by CLI and server.
 * Usage timestamps stay in a separate sidecar, outside access decisions.
 *
 * Portable signatures (a member signing their own events) are deferred:
 * this is authenticated attribution — the server vouches that the holder
 * of a live credential for `alice` submitted this — not cryptographic
 * non-repudiation.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./engine";
import { sharedMemberStore } from "./env";
import { writeAtomic } from "./fsx";
import { sha256hex } from "./hash";

export const SHARED_PERMISSIONS = ["read", "write"] as const;
export type SharedPermission = (typeof SHARED_PERMISSIONS)[number];
export type SharedRole = "owner" | "member";
export type SharedCredentialKind = "person" | "agent";

export interface SharedMember {
  /** `mem_` + 8 hex — a record key; the HANDLE is what events cite. */
  id: string;
  /** Immutable, unique, never reused: `[a-z0-9][a-z0-9._-]{0,63}`. */
  handle: string;
  /** How the member is shown; free text, one line. */
  display: string;
  role: SharedRole;
  permissions: SharedPermission[];
  created: string;
  /** Revocation timestamp; the record stays, the handle stays reserved. */
  revoked: string | null;
}

export interface SharedCredential {
  /** 8 hex — public, log-friendly. */
  id: string;
  member_id: string;
  /** Human label chosen at mint time ("laptop", "assistant"). */
  name: string;
  kind: SharedCredentialKind;
  /** Fixed credential scopes, unless followsMember explicitly tracks access. */
  scopes: SharedPermission[];
  /** Interactive member credential follows owner-managed access changes. */
  followsMember?: boolean;
  /** The credential that minted this one over the door (an app's agent
   * delegate). It stands only while that one does: revoking a leaked
   * credential cannot leave a delegate it minted behind. */
  minted_by?: string;
  /** hex sha256 of the full `sv_<id>_<secret>` string. */
  sha256: string;
  created: string;
  last_used: string | null;
  revoked: string | null;
}

interface MemberStore {
  version: 1;
  /** Informational — the filename hash is the key. */
  vault: string;
  members: SharedMember[];
  credentials: SharedCredential[];
}

/** The verified caller of one request. `permissions` is the EFFECTIVE set
 * (credential scopes ∩ member permissions); `role` is the member's. */
export interface SharedActor {
  member_id: string;
  handle: string;
  display: string;
  role: SharedRole;
  kind: SharedCredentialKind;
  credential_id: string;
  credential_name: string;
  permissions: SharedPermission[];
}

export type VerifyMemberResult = { ok: true; actor: SharedActor } | { ok: false; reason: string };

export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CREDENTIAL_RE = /^sv_([0-9a-f]{8})_[A-Za-z0-9_-]+$/u;

export class SharedMemberError extends Error {}

/** Where a shared vault's members live: `BIGBRAIN_SHARED_MEMBERS`, else
 * `~/.config/bigbrain/shared-members/<vault-hash>.json`. */
export function memberStorePath(vaultRoot: string): string {
  const env = sharedMemberStore();
  if (env) return env;
  return join(configDir(), "shared-members", `${sha256hex(vaultRoot).slice(0, 12)}.json`);
}

function readStore(storePath: string): MemberStore | undefined {
  if (!existsSync(storePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as MemberStore;
    if (raw?.version !== 1 || !Array.isArray(raw.members) || !Array.isArray(raw.credentials)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function requireStore(storePath: string): MemberStore {
  const store = readStore(storePath);
  if (!store) throw new SharedMemberError(`shared-members: no member store at ${storePath} — run \`bigbrain shared init\``);
  return store;
}

function writeStore(storePath: string, store: MemberStore): void {
  writeAtomic(storePath, `${JSON.stringify(store, null, 2)}\n`, 0o600);
}

function normalizePermissions(raw: readonly string[]): SharedPermission[] {
  const out = new Set<SharedPermission>();
  for (const p of raw) {
    if (!(SHARED_PERMISSIONS as readonly string[]).includes(p))
      throw new SharedMemberError(`shared-members: unknown permission "${p}" — use ${SHARED_PERMISSIONS.join(", ")}`);
    out.add(p as SharedPermission);
  }
  // `write` without `read` is not a thing: a writer must be able to see the
  // evidence it cites.
  if (out.has("write")) out.add("read");
  return SHARED_PERMISSIONS.filter((p) => out.has(p));
}

function checkHandle(handle: string): string {
  if (!HANDLE_RE.test(handle))
    throw new SharedMemberError(`shared-members: handle "${handle}" must match ${HANDLE_RE.source}`);
  return handle;
}

function checkOneLine(what: string, value: string, max: number): string {
  const v = value.trim().replace(/\s+/gu, " ");
  if (!v || v.length > max || /[\p{Cc}]/u.test(v))
    throw new SharedMemberError(`shared-members: ${what} must be one 1-${max} character line`);
  return v;
}

function memberByHandle(store: MemberStore, handle: string): SharedMember {
  const member = store.members.find((m) => m.handle === handle);
  if (!member) throw new SharedMemberError(`shared-members: no member "${handle}"`);
  return member;
}

/** Create the store with its ONE owner. Refuses to overwrite: an existing
 * store is somebody's membership, and clobbering it is never a setup step.
 * Returns the owner's first credential — printed once, never stored. */
function initMemberStoreLocked(
  storePath: string,
  vaultRoot: string,
  owner: { handle: string; display?: string; credentialName?: string },
  now: Date = new Date()
): { member: SharedMember; credential: SharedCredential; token: string } {
  if (existsSync(storePath))
    throw new SharedMemberError(`shared-members: ${storePath} already exists — refusing to replace a member store`);
  const handle = checkHandle(owner.handle);
  const member: SharedMember = {
    id: `mem_${randomBytes(4).toString("hex")}`,
    handle,
    display: checkOneLine("display", owner.display ?? handle, 120),
    role: "owner",
    permissions: ["read", "write"],
    created: now.toISOString(),
    revoked: null,
  };
  const store: MemberStore = { version: 1, vault: vaultRoot, members: [member], credentials: [] };
  writeStore(storePath, store);
  const minted = mintCredential(storePath, handle, { name: owner.credentialName ?? "owner", kind: "person" }, now);
  return { member, ...minted };
}

/** Add a member. Handles are unique across LIVE AND REVOKED members: a
 * handle is an author id in an append-only record, so a new person can
 * never inherit an old one's assertions by reusing the name. */
function addMemberLocked(
  storePath: string,
  input: { handle: string; display?: string; permissions?: readonly string[] },
  now: Date = new Date()
): SharedMember {
  const store = requireStore(storePath);
  const handle = checkHandle(input.handle);
  if (store.members.some((m) => m.handle === handle))
    throw new SharedMemberError(`shared-members: handle "${handle}" is taken (handles are never reused)`);
  const member: SharedMember = {
    id: `mem_${randomBytes(4).toString("hex")}`,
    handle,
    display: checkOneLine("display", input.display ?? handle, 120),
    role: "member",
    permissions: normalizePermissions(input.permissions ?? ["read"]),
    created: now.toISOString(),
    revoked: null,
  };
  store.members.push(member);
  writeStore(storePath, store);
  return member;
}

/** Change a member's permissions. Takes effect on their next request, on
 * every credential they hold. The owner's are fixed. */
function setMemberPermissionsLocked(
  storePath: string,
  handle: string,
  permissions: readonly string[]
): SharedMember {
  const store = requireStore(storePath);
  const member = memberByHandle(store, handle);
  if (member.role === "owner") throw new SharedMemberError("shared-members: the owner's permissions are fixed");
  if (member.revoked) throw new SharedMemberError(`shared-members: "${handle}" is revoked`);
  member.permissions = normalizePermissions(permissions);
  writeStore(storePath, store);
  return member;
}

/** Mint a credential for a member. The ONLY function that ever sees the
 * plaintext secret. Scopes must be a subset of the member's permissions —
 * a credential is never a way to escalate — and default to all of them. */
function mintCredentialLocked(
  storePath: string,
  handle: string,
  input: { name: string; kind?: SharedCredentialKind; scopes?: readonly string[]; followsMember?: boolean; mintedBy?: string },
  now: Date = new Date()
): { credential: SharedCredential; token: string } {
  const store = requireStore(storePath);
  const member = memberByHandle(store, handle);
  if (member.revoked) throw new SharedMemberError(`shared-members: "${handle}" is revoked`);
  const kind = input.kind ?? "person";
  if (kind !== "person" && kind !== "agent")
    throw new SharedMemberError(`shared-members: credential kind must be person or agent`);
  if(input.followsMember && (input.scopes || kind!=='person'))throw new SharedMemberError('Member-following credentials must be unscoped person credentials');
  const scopes = input.scopes ? normalizePermissions(input.scopes) : [...member.permissions];
  for (const scope of scopes)
    if (!member.permissions.includes(scope))
      throw new SharedMemberError(
        `shared-members: "${handle}" does not hold "${scope}" — a credential cannot exceed its member (${member.permissions.join(", ") || "none"})`
      );
  const id = randomBytes(4).toString("hex");
  const token = `sv_${id}_${randomBytes(32).toString("base64url")}`;
  const credential: SharedCredential = {
    id,
    member_id: member.id,
    name: checkOneLine("credential name", input.name, 120),
    kind,
    scopes,
    ...(input.followsMember ? {followsMember:true} : {}),
    ...(input.mintedBy ? { minted_by: input.mintedBy } : {}),
    sha256: sha256hex(token),
    created: now.toISOString(),
    last_used: null,
    revoked: null,
  };
  store.credentials.push(credential);
  writeStore(storePath, store);
  return { credential, token };
}

// The same work whether or not the id is known, so timing never says which.
const DUMMY_DIGEST = Buffer.from(sha256hex("shared-vault-dummy"), "hex");

/** Verify a presented credential and derive the actor. `reason` is for the
 * SERVER LOG only — the wire answers an undifferentiated 401. */
export function verifyCredential(storePath: string, presented: string): VerifyMemberResult {
  const store = readStore(storePath);
  if (!store) return { ok: false, reason: "member store missing or unreadable" };
  if (!store.credentials.length) return { ok: false, reason: "member store has no credentials" };

  const m = CREDENTIAL_RE.exec(presented);
  const credential = m ? store.credentials.find((c) => c.id === m[1]) : undefined;
  const expected = credential ? Buffer.from(credential.sha256, "hex") : DUMMY_DIGEST;
  const actual = createHash("sha256").update(presented).digest();
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!m) return { ok: false, reason: "malformed credential" };
  if (!credential) return { ok: false, reason: `unknown credential id ${m[1]}` };
  if (!match) return { ok: false, reason: `secret mismatch for credential ${credential.id}` };
  if (credential.revoked) return { ok: false, reason: `credential ${credential.id} revoked at ${credential.revoked}` };
  if (credential.minted_by && !store.credentials.some((c) => c.id === credential.minted_by && !c.revoked))
    return { ok: false, reason: `credential ${credential.id} was minted by revoked credential ${credential.minted_by}` };
  const member = store.members.find((one) => one.id === credential.member_id);
  if (!member) return { ok: false, reason: `credential ${credential.id} names no member` };
  if (member.revoked) return { ok: false, reason: `member ${member.handle} revoked at ${member.revoked}` };
  return {
    ok: true,
    actor: {
      member_id: member.id,
      handle: member.handle,
      display: member.display,
      role: member.role,
      kind: credential.kind,
      credential_id: credential.id,
      credential_name: credential.name,
      permissions: SHARED_PERMISSIONS.filter((p) => (credential.followsMember || credential.scopes.includes(p)) && member.permissions.includes(p)),
    },
  };
}

export function hasPermission(actor: SharedActor, permission: SharedPermission): boolean {
  return actor.permissions.includes(permission);
}

/** Revoke a member and every credential they hold. The owner cannot be
 * revoked — there is one authoritative vault and it has one operator;
 * handing it over is a store edit an operator makes deliberately. */
function revokeMemberLocked(storePath: string, handle: string, now: Date = new Date()): SharedMember {
  const store = requireStore(storePath);
  const member = memberByHandle(store, handle);
  if (member.role === "owner") throw new SharedMemberError("shared-members: the owner cannot be revoked");
  const at = now.toISOString();
  member.revoked ??= at;
  for (const c of store.credentials) if (c.member_id === member.id) c.revoked ??= at;
  writeStore(storePath, store);
  return member;
}

/** Revoke one credential; the member and their other credentials stand. */
function revokeCredentialLocked(storePath: string, id: string, now: Date = new Date()): boolean {
  const store = readStore(storePath);
  const credential = store?.credentials.find((c) => c.id === id);
  if (!store || !credential) return false;
  credential.revoked ??= now.toISOString();
  writeStore(storePath, store);
  return true;
}

/** Where the server records `last_used`: beside the store, never in it. */
export const usagePath = (storePath: string): string => `${storePath}.usage.json`;

function readUsage(storePath: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(usagePath(storePath), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Record a use in the SIDECAR — the store itself is never written by the
 * usage recorder. Throttled to one write a minute per credential. */
export function touchCredential(storePath: string, id: string, now: Date = new Date()): void {
  const usage = readUsage(storePath);
  const last = usage[id];
  if (last && now.getTime() - Date.parse(last) < 60_000) return;
  usage[id] = now.toISOString();
  writeAtomic(usagePath(storePath), `${JSON.stringify(usage, null, 2)}\n`, 0o600);
}

export function listMembers(storePath: string): SharedMember[] {
  return readStore(storePath)?.members ?? [];
}

/** Credentials with `last_used` merged in from the sidecar. */
export function listCredentials(storePath: string, handle?: string): SharedCredential[] {
  const store = readStore(storePath);
  if (!store) return [];
  const usage = readUsage(storePath);
  const rows = store.credentials.map((c) => ({ ...c, last_used: usage[c.id] ?? c.last_used }));
  if (!handle) return rows;
  const member = store.members.find((m) => m.handle === handle);
  return member ? rows.filter((c) => c.member_id === member.id) : [];
}

export function ownerOf(storePath: string): SharedMember | undefined {
  return readStore(storePath)?.members.find((m) => m.role === "owner");
}

export const initMemberStore = (...args: Parameters<typeof initMemberStoreLocked>): ReturnType<typeof initMemberStoreLocked> => withMemberLock(args[0],()=>initMemberStoreLocked(...args));

export const addMember = (...args: Parameters<typeof addMemberLocked>): ReturnType<typeof addMemberLocked> => withMemberLock(args[0],()=>addMemberLocked(...args));

export const setMemberPermissions = (...args: Parameters<typeof setMemberPermissionsLocked>): ReturnType<typeof setMemberPermissionsLocked> => withMemberLock(args[0],()=>setMemberPermissionsLocked(...args));

export const mintCredential = (...args: Parameters<typeof mintCredentialLocked>): ReturnType<typeof mintCredentialLocked> => withMemberLock(args[0],()=>mintCredentialLocked(...args));

export const revokeMember = (...args: Parameters<typeof revokeMemberLocked>): ReturnType<typeof revokeMemberLocked> => withMemberLock(args[0],()=>revokeMemberLocked(...args));

export const revokeCredential = (...args: Parameters<typeof revokeCredentialLocked>): ReturnType<typeof revokeCredentialLocked> => withMemberLock(args[0],()=>revokeCredentialLocked(...args));
