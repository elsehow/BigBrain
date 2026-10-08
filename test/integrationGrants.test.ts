/** integrationGrants.test.ts — live access is granted per caller, and grants
 * are the only thing that grants it. Covers the access reset an account
 * policy written by an older engine (version 2) goes through when it is read,
 * the defaults a new account and a new client start at, and that saving one
 * caller's access never changes another's. Every account and client here is
 * invented. */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitVault } from "./support/vault";
import { writeAtomic } from "../lib/fsx";
import { sha256hex } from "../lib/hash";
import { mintToken, renewToken, revokeToken } from "../lib/auth";
import { readEnvValues } from "../lib/envFile";
import { IntegrationAccounts } from "../lib/integrationAccounts";
import { configSave } from "../lib/configWrite";
import { policyPath } from "../lib/integrations/contract";
import { accountFingerprint, accountPolicy, integrationFingerprint, readableIntegrationAccounts, requireIntegrationWrite, type IntegrationCaller } from "../lib/integrationAccess";

const originalStore = process.env.BIGBRAIN_TOKENS;
const roots: string[] = [];
afterAll(() => { if (originalStore === undefined) delete process.env.BIGBRAIN_TOKENS; else process.env.BIGBRAIN_TOKENS = originalStore; for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function vault(yaml = "integrations:\n  email:\n    inboxes:\n      - address: me@example.com\n        host: imap.example.com\n      - address: work@example.com\n        host: imap.example.com\n  rss:\n    feeds:\n      - url: https://feeds.example.com/news.xml\n        title: Example news\n") {
  const root = gitVault({ files: { "vault.yaml": yaml, ".env": "BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM=synthetic\nBIGBRAIN_IMAP_PASSWORD__WORK_EXAMPLE_COM=synthetic-work\n", ".gitignore": ".env\n.spool/\n.state/\n" } });
  roots.push(root);
  writeAtomic(join(root, ".spool/source-mcp/granola", sha256hex("granola") + ".json"), JSON.stringify({ generation: "fixture", connected: true, redirect: "http://127.0.0.1/callback",
    tokens: { access_token: "synthetic", token_type: "Bearer" }, identity: { workspace: "fixture" } }), 0o600);
  return root;
}
const root = vault();
const store = join(root, "tokens.json");
process.env.BIGBRAIN_TOKENS = store;
const a = mintToken(store, root, "Client A", ["vault:read"], { kind: "agent" }), b = mintToken(store, root, "Client B", ["vault:read"], { kind: "agent" });
const A = `token:${a.record.id}`, B = `token:${b.record.id}`;
const ME = "me@example.com", WORK = "work@example.com", FEED = "https://feeds.example.com/news.xml";
const mcp = (t: { token: string }): IntegrationCaller => ({ kind: "mcp", token: t.token, storePath: store });
/** Whether Pilot, client A and client B can read the account. */
const readers = (name: string, account: string, at = root) => [{ kind: "pilot" } as IntegrationCaller, mcp(a), mcp(b)].map(c => readableIntegrationAccounts(at, name, c).includes(account));
const writes = (name: string, account: string, caller: IntegrationCaller) => { try { requireIntegrationWrite(root, name, account, caller); return true; } catch { return false; } };
/** A policy file exactly as some engine wrote it. */
function raw(name: string, account: string, value: Record<string, unknown>, at = root) {
  const path = policyPath(at, name, account);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ connected: true, fingerprint: accountFingerprint(at, name, account), checkedAt: "2026-01-01T00:00:00.000Z", grants: [], ...value }) + "\n");
}
const onDisk = (name: string, account: string) => JSON.parse(readFileSync(policyPath(root, name, account), "utf8"));
const api = new IntegrationAccounts(root, { email: async () => {}, rss: async () => ({ title: "Second feed", items: [] }) });

test("grants are the only source of live access", () => {
  raw("email", ME, { version: 3, grants: [{ caller: "pilot", access: "read" }, { caller: A, access: "read-write" }] });
  expect(readers("email", ME)).toEqual([true, true, false]);
  expect([{ kind: "pilot" } as IntegrationCaller, mcp(a), mcp(b)].map(c => writes("email", ME, c))).toEqual([false, true, false]);
  // a `liveAccess` left in a current policy decides nothing
  raw("email", WORK, { version: 3, liveAccess: true, grants: [] });
  expect(readers("email", WORK)).toEqual([false, false, false]);
  expect(accountPolicy(root, "email", WORK)).not.toHaveProperty("liveAccess");
});

test("upgrade: Pilot keeps read where it could read, every client starts off, and nothing else changes", () => {
  const email = { startAt: "2026-01-01T00:00:00.000Z", attachments: true };
  const cases: [string, Record<string, unknown>, boolean][] = [
    ["live access on, for everyone", { liveAccess: true, grants: [{ caller: A, access: "read-write" }] }, true],
    ["live access off, over a Pilot grant", { liveAccess: false, grants: [{ caller: "pilot", access: "read" }, { caller: A, access: "read" }] }, false],
    ["Pilot read-write, never kept as such", { grants: [{ caller: "pilot", access: "read-write" }, { caller: A, access: "read-write" }] }, true],
    ["Pilot read", { grants: [{ caller: "pilot", access: "read" }, { caller: B, access: "read" }] }, true],
    ["Pilot off", { grants: [{ caller: "pilot", access: "off" }, { caller: A, access: "read" }] }, false],
    ["no Pilot grant", { grants: [{ caller: A, access: "read" }, { caller: B, access: "read-write" }] }, false],
  ];
  for (const [label, value, pilot] of cases) {
    raw("email", ME, { version: 2, email, ...value });
    expect([label, readers("email", ME)]).toEqual([label, [pilot, false, false]]);
    expect([label, writes("email", ME, { kind: "pilot" })]).toEqual([label, false]);
    const policy = accountPolicy(root, "email", ME);
    expect(policy).toEqual({ version: 3, connected: true, fingerprint: accountFingerprint(root, "email", ME), checkedAt: "2026-01-01T00:00:00.000Z", email,
      grants: pilot ? [{ caller: "pilot", access: "read" }] : [] });
  }
  // disconnected stays disconnected, and keeps what Pilot will read once reconnected
  raw("email", WORK, { version: 2, connected: false, liveAccess: true });
  expect(accountPolicy(root, "email", WORK)).toMatchObject({ connected: false, grants: [{ caller: "pilot", access: "read" }] });
  // the Granola sign-in is kept, and live access on became Pilot read
  raw("granola", "granola", { version: 2, liveAccess: true, granola: { backfill: { since: "2026-01-01T00:00:00.000Z", request: "r1" } } });
  expect(readers("granola", "granola")).toEqual([true, false, false]);
  expect(accountPolicy(root, "granola", "granola")).toMatchObject({ connected: true, granola: { backfill: { request: "r1" } } });
  // an integration with no live tools is granted nothing, whatever it said
  raw("rss", FEED, { version: 2, liveAccess: true, grants: [{ caller: "pilot", access: "read" }] });
  expect(accountPolicy(root, "rss", FEED)).toMatchObject({ connected: true, grants: [] });
});

test("upgrade: an old file stays as it was until the next change writes version 3", async () => {
  raw("email", ME, { version: 2, liveAccess: true, grants: [{ caller: A, access: "read" }], email: { startAt: "2026-01-01T00:00:00.000Z", attachments: false } });
  const before = readFileSync(policyPath(root, "email", ME), "utf8");
  for (let i = 0; i < 3; i++) expect(readers("email", ME)).toEqual([true, false, false]);
  expect(readFileSync(policyPath(root, "email", ME), "utf8")).toBe(before);
  await api.update({ name: "email", account: ME, action: "save", grants: [{ caller: B, access: "read" }] });
  const written = onDisk("email", ME);
  expect(written).toMatchObject({ version: 3, connected: true, email: { startAt: "2026-01-01T00:00:00.000Z" }, grants: [{ caller: "pilot", access: "read" }, { caller: B, access: "read" }] });
  expect(written).not.toHaveProperty("liveAccess");
  expect(readers("email", ME)).toEqual([true, false, true]);
  // credentials were never part of it
  expect(readEnvValues(root).BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM).toBe("synthetic");
});

test("upgrade: an activation from before account policies keeps Pilot only", () => {
  const legacy = vault("integrations:\n  email:\n    inboxes:\n      - address: me@example.com\n        host: imap.example.com\n      - address: work@example.com\n        host: imap.example.com\n");
  writeAtomic(join(legacy, ".spool/integration-access/email.json"), JSON.stringify({ version: 1, active: true, fingerprint: integrationFingerprint(legacy, "email"), checkedAt: "2026-01-01T00:00:00.000Z",
    grants: [{ caller: "pilot", accounts: [ME] }, { caller: A, accounts: [ME, WORK] }] }), 0o600);
  expect(accountPolicy(legacy, "email", ME)).toMatchObject({ version: 3, connected: true, grants: [{ caller: "pilot", access: "read" }] });
  expect(accountPolicy(legacy, "email", WORK)).toMatchObject({ version: 3, connected: true, grants: [] });
  expect(readers("email", ME, legacy)).toEqual([true, false, false]);
});

test("upgrade: a first sign-in or connection never widens what an older engine recorded", async () => {
  // Granola added with Live access unticked, and first signed in after the update
  raw("granola", "granola", { version: 2, connected: false, checkedAt: null, liveAccess: false });
  const signIn = new IntegrationAccounts(root, { granolaSignIn: async (_root, _account, done) => { done(); return undefined as never; } });
  await signIn.update({ name: "granola", account: "granola", action: "connect" });
  expect(accountPolicy(root, "granola", "granola")).toMatchObject({ connected: true, grants: [] });
  expect(readers("granola", "granola")).toEqual([false, false, false]);
  // an inbox an older engine knew but never connected
  raw("email", WORK, { version: 2, connected: false, checkedAt: null, grants: [] });
  await api.update({ name: "email", account: WORK, action: "connect" });
  expect(readers("email", WORK)).toEqual([false, false, false]);
});

test("a configuration save never writes grants: readers are refused, and activation keeps each account's", async () => {
  const at = vault(), save = (op: Record<string, unknown>) => configSave(at, JSON.stringify({ integrations: [op] }), async () => {});
  raw("email", ME, { version: 3, grants: [{ caller: A, access: "read" }] }, at);
  raw("email", WORK, { version: 3, connected: false, grants: [] }, at);
  const before = readFileSync(policyPath(at, "email", ME), "utf8");
  for (const op of [{ name: "email", enabled: true, activate: true, readers: [{ caller: B, accounts: [ME, WORK] }] }, { name: "email", readers: [] }]) {
    const refused = await save(op);
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body).error).toContain("Settings → Integrations");
  }
  expect(readFileSync(policyPath(at, "email", ME), "utf8")).toBe(before);
  expect((await save({ name: "email", enabled: true, activate: true })).status).toBe(200);
  expect(accountPolicy(at, "email", ME)).toMatchObject({ connected: true, grants: [{ caller: A, access: "read" }] });
  expect(accountPolicy(at, "email", WORK)).toMatchObject({ connected: true, grants: [] });
  expect(readers("email", ME, at)).toEqual([false, true, false]);
});

test("an unknown or malformed policy fails closed", () => {
  for (const value of [{ version: 4, grants: [{ caller: "pilot", access: "read" }] }, { version: 1, grants: [{ caller: "pilot", access: "read" }] },
    { grants: [{ caller: "pilot", access: "read" }] }, { version: 3, grants: [{ caller: "gardener", access: "read" }] }, { version: 3, grants: [{ caller: "pilot", access: "all" }] }]) {
    raw("email", ME, value);
    expect(accountPolicy(root, "email", ME)).toEqual({ version: 3, connected: false, fingerprint: "", checkedAt: null, grants: [] });
    expect(readers("email", ME)).toEqual([false, false, false]);
  }
  // a coding desktop is a caller kind a policy may name; nothing offers it yet
  raw("email", ME, { version: 3, grants: [{ caller: "desktop:sample", access: "read" }, { caller: "pilot", access: "read" }] });
  expect(readers("email", ME)).toEqual([true, false, false]);
  expect(api.list().callers.map(c => c.id)).not.toContain("desktop:sample");
});

test("saving one caller's access never changes another's", async () => {
  raw("email", ME, { version: 3, grants: [{ caller: "pilot", access: "read" }, { caller: A, access: "read" }] });
  const grants = () => accountPolicy(root, "email", ME).grants;
  const save = (value: Record<string, unknown>) => api.update({ name: "email", account: ME, action: "save", ...value });
  await save({ grants: [{ caller: B, access: "read-write" }] });
  expect(grants()).toEqual([{ caller: "pilot", access: "read" }, { caller: A, access: "read" }, { caller: B, access: "read-write" }]);
  await save({ grants: [{ caller: "pilot", access: "off" }] });
  expect(grants()).toEqual([{ caller: A, access: "read" }, { caller: B, access: "read-write" }]);
  await save({});
  expect(grants()).toEqual([{ caller: A, access: "read" }, { caller: B, access: "read-write" }]);
  await api.update({ name: "email", account: ME, action: "grant", caller: A, access: "read-write" });
  expect(grants()).toEqual([{ caller: B, access: "read-write" }, { caller: A, access: "read-write" }]);
  expect(readers("email", ME)).toEqual([false, true, true]);
  // the one switch for everyone is gone, and nothing outside the offered callers and levels is taken
  for (const value of [{ liveAccess: true }, { grants: [{ caller: "token:ffffffff", access: "read" }] }, { grants: [{ caller: "desktop:sample", access: "read" }] },
    { grants: [{ caller: "pilot", access: "read" }, { caller: "pilot", access: "off" }] }, { grants: [{ caller: "pilot", access: "everything" }] }])
    await expect(save(value)).rejects.toThrow("caller");
  await expect(api.update({ name: "rss", account: FEED, action: "grant", caller: "pilot", access: "read" })).rejects.toThrow("supported");
  expect(grants()).toEqual([{ caller: B, access: "read-write" }, { caller: A, access: "read-write" }]);
  // a revoked client's grant goes with the next change
  const c = mintToken(store, root, "Client C", ["vault:read"], { kind: "agent" });
  await save({ grants: [{ caller: `token:${c.record.id}`, access: "read" }] });
  revokeToken(store, c.record.id);
  await save({ grants: [{ caller: "pilot", access: "read" }] });
  expect(grants()).toEqual([{ caller: B, access: "read-write" }, { caller: A, access: "read-write" }, { caller: "pilot", access: "read" }]);
});

test("a new account starts at Pilot read with every client off; a new client starts off everywhere", async () => {
  await api.update({ name: "email", action: "add", address: "new@gmail.com", password: "abcdefghijklmnop" });
  expect(accountPolicy(root, "email", "new@gmail.com").grants).toEqual([{ caller: "pilot", access: "read" }]);
  expect(readers("email", "new@gmail.com")).toEqual([true, false, false]);
  await api.update({ name: "rss", action: "add", url: "https://feeds.example.com/second.xml" });
  expect(accountPolicy(root, "rss", "https://feeds.example.com/second.xml")).toMatchObject({ connected: true, grants: [] });
  // first connected here rather than added here: the same default
  rmSync(policyPath(root, "email", WORK), { force: true });
  await api.update({ name: "email", account: WORK, action: "connect" });
  expect(readers("email", WORK)).toEqual([true, false, false]);
  // a reconnection keeps what was chosen
  await api.update({ name: "email", account: WORK, action: "grant", caller: "pilot", access: "off" });
  await api.update({ name: "email", account: WORK, action: "disconnect" });
  await api.update({ name: "email", account: WORK, action: "connect" });
  expect(readers("email", WORK)).toEqual([false, false, false]);
  // a client connected after grants were chosen reads nothing until granted, and is offered by name
  await api.update({ name: "email", account: "new@gmail.com", action: "grant", caller: A, access: "read" });
  const d = mintToken(store, root, "Client D", ["vault:read"], { kind: "agent" }), D = `token:${d.record.id}`;
  for (const account of [ME, WORK, "new@gmail.com"]) expect(readableIntegrationAccounts(root, "email", mcp(d))).not.toContain(account);
  expect(readableIntegrationAccounts(root, "granola", mcp(d))).toEqual([]);
  expect(api.list().callers).toContainEqual({ id: D, label: "Client D" });
  expect(api.list().accounts.flatMap(x => x.grants.map(g => g.caller))).not.toContain(D);
});

test("a lapsed client is offered marked expired and reads nothing; renewing it brings its grants back", async () => {
  raw("email", ME, { version: 3, grants: [{ caller: "pilot", access: "read" }] });
  const e = mintToken(store, root, "Client E", ["vault:read"], { kind: "agent" }), E = `token:${e.record.id}`;
  await api.update({ name: "email", account: ME, action: "grant", caller: E, access: "read" });
  expect(readableIntegrationAccounts(root, "email", mcp(e))).toEqual([ME]);
  // left unused for 31 days
  const tokens = JSON.parse(readFileSync(store, "utf8"));
  Object.assign(tokens.tokens.find((t: { id: string }) => t.id === e.record.id), { created: new Date(Date.now() - 31 * 86_400_000).toISOString(), last_used: null });
  writeFileSync(store, JSON.stringify(tokens));
  expect(api.list().callers).toContainEqual({ id: E, label: "Client E", expired: true });
  expect(() => readableIntegrationAccounts(root, "email", mcp(e))).toThrow("Authenticate");
  expect(accountPolicy(root, "email", ME).grants).toContainEqual({ caller: E, access: "read" });
  renewToken(store, e.record.id);
  expect(api.list().callers).toContainEqual({ id: E, label: "Client E" });
  expect(readableIntegrationAccounts(root, "email", mcp(e))).toEqual([ME]);
});
