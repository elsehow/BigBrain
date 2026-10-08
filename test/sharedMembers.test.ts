import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMember,
  initMemberStore,
  listCredentials,
  listMembers,
  mintCredential,
  revokeCredential,
  revokeMember,
  setMemberPermissions,
  touchCredential,
  usagePath,
  verifyCredential,
} from "../lib/sharedMembers";
import { SharedMemberBusyError } from "../lib/sharedMemberLock";
import { holdElsewhere } from "./support/lockElsewhere";

const scratch = (): { store: string; vault: string } => {
  const dir = mkdtempSync(join(tmpdir(), "bb-shared-members-"));
  return { store: join(dir, "members.json"), vault: join(dir, "vault") };
};

describe("shared-vault member store", () => {
  test("init creates the one owner and prints a credential once; the file is private and holds only a digest", () => {
    const { store, vault } = scratch();
    const r = initMemberStore(store, vault, { handle: "owner", display: "The Owner" });
    expect(r.member.role).toBe("owner");
    expect(r.member.permissions).toEqual(["read", "write"]);
    expect(r.token.startsWith(`sv_${r.credential.id}_`)).toBe(true);
    expect(statSync(store).mode & 0o777).toBe(0o600);
    const raw = readFileSync(store, "utf8");
    expect(raw).not.toContain(r.token);
    expect(raw).toContain(r.credential.sha256);
    // a second init must not clobber a membership
    expect(() => initMemberStore(store, vault, { handle: "again" })).toThrow(/already exists/u);
  });

  test("verify derives the actor from the credential: member, role, kind, effective permissions", () => {
    const { store, vault } = scratch();
    initMemberStore(store, vault, { handle: "owner" });
    addMember(store, { handle: "alice", display: "Alice", permissions: ["read", "write"] });
    const laptop = mintCredential(store, "alice", { name: "laptop" });
    const helper = mintCredential(store, "alice", { name: "helper", kind: "agent", scopes: ["read"] });
    const a = verifyCredential(store, laptop.token);
    expect(a.ok && a.actor).toMatchObject({ handle: "alice", role: "member", kind: "person", permissions: ["read", "write"], credential_name: "laptop" });
    const b = verifyCredential(store, helper.token);
    expect(b.ok && b.actor).toMatchObject({ handle: "alice", kind: "agent", permissions: ["read"], credential_name: "helper" });
  });

  test("fails closed: missing store, malformed, unknown id, wrong secret, revoked credential, revoked member", () => {
    const { store, vault } = scratch();
    expect(verifyCredential(store, "sv_00000000_x")).toMatchObject({ ok: false, reason: expect.stringContaining("missing") });
    initMemberStore(store, vault, { handle: "owner" });
    addMember(store, { handle: "bob", permissions: ["read", "write"] });
    const bob = mintCredential(store, "bob", { name: "phone" });
    expect(verifyCredential(store, "")).toMatchObject({ ok: false, reason: "malformed credential" });
    expect(verifyCredential(store, "bb_12345678_notashared")).toMatchObject({ ok: false, reason: "malformed credential" });
    expect(verifyCredential(store, `sv_${"0".repeat(8)}_nope`)).toMatchObject({ ok: false, reason: expect.stringContaining("unknown") });
    expect(verifyCredential(store, `sv_${bob.credential.id}_wrongsecret`)).toMatchObject({ ok: false, reason: expect.stringContaining("mismatch") });
    expect(verifyCredential(store, bob.token).ok).toBe(true);
    expect(revokeCredential(store, bob.credential.id)).toBe(true);
    expect(verifyCredential(store, bob.token)).toMatchObject({ ok: false, reason: expect.stringContaining("revoked") });
    const bob2 = mintCredential(store, "bob", { name: "phone 2" });
    expect(verifyCredential(store, bob2.token).ok).toBe(true);
    revokeMember(store, "bob");
    // member revocation revokes every credential too, so the credential's
    // own stamp is what verify hits first — either way, nobody
    expect(verifyCredential(store, bob2.token)).toMatchObject({ ok: false, reason: expect.stringContaining("revoked") });
    expect(listCredentials(store, "bob").every((c) => c.revoked)).toBe(true);
    expect(() => mintCredential(store, "bob", { name: "after" })).toThrow(/revoked/u);
  });

  test("a credential cannot exceed its member, and narrowing a member narrows every credential immediately", () => {
    const { store, vault } = scratch();
    initMemberStore(store, vault, { handle: "owner" });
    addMember(store, { handle: "carol", permissions: ["read"] });
    expect(() => mintCredential(store, "carol", { name: "x", scopes: ["write"] })).toThrow(/cannot exceed/u);
    setMemberPermissions(store, "carol", ["read", "write"]);
    const c = mintCredential(store, "carol", { name: "x", scopes: ["read", "write"] });
    expect(verifyCredential(store, c.token)).toMatchObject({ ok: true, actor: { permissions: ["read", "write"] } });
    setMemberPermissions(store, "carol", ["read"]);
    expect(verifyCredential(store, c.token)).toMatchObject({ ok: true, actor: { permissions: ["read"] } });
    // write implies read — a writer must be able to see what it cites
    setMemberPermissions(store, "carol", ["write"]);
    expect(listMembers(store).find((m) => m.handle === "carol")!.permissions).toEqual(["read", "write"]);
    expect(() => setMemberPermissions(store, "carol", ["admin"])).toThrow(/unknown permission/u);
  });

  test("handles are validated, unique and never reused; the owner is fixed", () => {
    const { store, vault } = scratch();
    initMemberStore(store, vault, { handle: "owner" });
    expect(() => addMember(store, { handle: "Not Valid" })).toThrow(/must match/u);
    expect(() => addMember(store, { handle: "../x" })).toThrow(/must match/u);
    expect(() => addMember(store, { handle: "owner" })).toThrow(/taken/u);
    addMember(store, { handle: "dave" });
    revokeMember(store, "dave");
    expect(() => addMember(store, { handle: "dave" })).toThrow(/never reused/u);
    expect(() => revokeMember(store, "owner")).toThrow(/cannot be revoked/u);
    expect(() => setMemberPermissions(store, "owner", ["read"])).toThrow(/fixed/u);
  });

  test("touch records use in the sidecar and never writes the store: a revocation landing meanwhile cannot be overwritten", () => {
    const { store, vault } = scratch();
    const r = initMemberStore(store, vault, { handle: "owner" });
    addMember(store, { handle: "bob" });
    const bob = mintCredential(store, "bob", { name: "phone" });
    // the operator revokes bob in one process while the server touches in another:
    // the store's bytes after the touch are exactly the operator's
    revokeMember(store, "bob");
    const before = readFileSync(store, "utf8");
    touchCredential(store, bob.credential.id, new Date("2026-01-01T00:00:00Z"));
    touchCredential(store, r.credential.id, new Date("2026-01-01T00:00:00Z"));
    expect(readFileSync(store, "utf8")).toBe(before);
    expect(verifyCredential(store, bob.token).ok).toBe(false);
    expect((statSync(usagePath(store)).mode & 0o777).toString(8)).toBe("600");
    const rec = listCredentials(store).find((c) => c.id === bob.credential.id)!;
    expect(rec.revoked).not.toBeNull();
    expect(rec.last_used).toBe("2026-01-01T00:00:00.000Z");
    expect(listCredentials(store, "owner")[0]!.last_used).toBe("2026-01-01T00:00:00.000Z");
    // throttled: a second touch within the minute does not rewrite
    touchCredential(store, r.credential.id, new Date("2026-01-01T00:00:30Z"));
    expect(listCredentials(store, "owner")[0]!.last_used).toBe("2026-01-01T00:00:00.000Z");
    touchCredential(store, r.credential.id, new Date("2026-01-01T00:01:01Z"));
    expect(listCredentials(store, "owner")[0]!.last_used).toBe("2026-01-01T00:01:01.000Z");
    // a damaged sidecar is not a refusal: usage is informational
    writeFileSync(usagePath(store), "{not json");
    expect(() => touchCredential(store, r.credential.id, new Date("2026-01-01T00:02:02Z"))).not.toThrow();
    expect(listCredentials(store, "owner")[0]!.last_used).toBe("2026-01-01T00:02:02.000Z");
  });
});

describe("the member store's lock", () => {
  test("a change elsewhere makes this one busy, never stuck: freed the moment that process dies", async () => {
    const { store, vault } = scratch();
    mkdirSync(store + ".lock"); // what an interrupted change left before: it refused every change after it
    initMemberStore(store, vault, { handle: "owner" });
    expect(existsSync(store + ".lock")).toBe(false);
    const other = await holdElsewhere("sqliteLock.ts", "tryHold", [store + ".lock.sqlite"]);
    try {
      expect(() => addMember(store, { handle: "ada" })).toThrow(SharedMemberBusyError);
    } finally { await other.kill(); }
    expect(addMember(store, { handle: "ada" }).handle).toBe("ada");
    expect(listMembers(store).map(m => m.handle)).toEqual(["owner", "ada"]);
  });
});
