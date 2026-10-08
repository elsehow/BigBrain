import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { nativeVault } from "./support/vault";
import { listTokens, mintToken, noteExpiredUse, renewToken, revokeToken, touchLastUsed, verifyToken } from "../lib/auth";
import { ConnectedClients, ConnectionExpired, authenticateClient } from "../lib/connectedClients";
import { makeApiHandler } from "../lib/api";
import { readableIntegrationAccounts } from "../lib/integrationAccess";
import { readSourceInsertionLog } from "../lib/insertionLog";

const DAY = 86_400_000;
const FIX = "This BigBrain connection expired after 30 days unused. Renew it in BigBrain → Settings → Connected clients.";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = nativeVault({ files: { "vault.yaml": "{}", "memory/MEMORY.md": "# Memory\n\nA synthetic vault." } });
  roots.push(root);
  return { root, clients: new ConnectedClients(root, join(root, "tokens.json")) };
}
/** Move a credential's whole history `days` into the past, as a store left alone that long would read. */
function age(store: string, id: string, days: number) {
  const raw = JSON.parse(readFileSync(store, "utf8"));
  const t = raw.tokens.find((t: { id: string }) => t.id === id);
  const back = (s: string | null | undefined) => (s ? new Date(Date.parse(s) - days * DAY).toISOString() : s);
  Object.assign(t, { created: back(t.created), last_used: back(t.last_used), renewed: back(t.renewed) });
  writeFileSync(store, JSON.stringify(raw));
}
const at = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY);

test("a vault-reading credential lapses 30 days after its last use, and use keeps it alive", () => {
  const { root } = fixture(), store = join(root, "tokens.json");
  const { token, record } = mintToken(store, root, "reader", ["vault:read", "inbox:write"], { kind: "agent", via: "client" });
  expect(verifyToken(store, token, at(record.created, 29)).ok).toBe(true);
  touchLastUsed(store, record.id, at(record.created, 29));
  expect(verifyToken(store, token, at(record.created, 58)).ok).toBe(true);
  const lapsed = verifyToken(store, token, at(record.created, 59));
  expect(lapsed.ok).toBe(false);
  if (lapsed.ok) return;
  expect(lapsed.reason).toBe(`token ${record.id} expired after 30 days unused`);
  expect(lapsed.expired?.id).toBe(record.id);
});

test("a credential never used lapses 30 days after it was minted", () => {
  const { root } = fixture(), store = join(root, "tokens.json");
  const { token, record } = mintToken(store, root, "never used", ["vault:read"]);
  expect(verifyToken(store, token, new Date(Date.parse(record.created) + 30 * DAY - 1)).ok).toBe(true);
  expect(verifyToken(store, token, at(record.created, 30)).ok).toBe(false);
});

test("only the holder learns it lapsed; a wrong secret or a revoked credential is refused as before", () => {
  const { root } = fixture(), store = join(root, "tokens.json");
  const { token, record } = mintToken(store, root, "reader", ["vault:read"]);
  const wrong = verifyToken(store, `bb_${record.id}_not-the-secret`, at(record.created, 40));
  expect(!wrong.ok && wrong.expired).toBeFalsy();
  revokeToken(store, record.id);
  const revoked = verifyToken(store, token, at(record.created, 40));
  expect(!revoked.ok && revoked.expired).toBeFalsy();
  expect(renewToken(store, record.id)).toBe(false);
});

test("a record with no readable timestamp counts as lapsed", () => {
  const { root } = fixture(), store = join(root, "tokens.json");
  const { token } = mintToken(store, root, "reader", ["vault:read"]);
  const raw = JSON.parse(readFileSync(store, "utf8"));
  raw.tokens[0].created = "not a date";
  writeFileSync(store, JSON.stringify(raw));
  expect(verifyToken(store, token).ok).toBe(false);
});

test("pairing and tend credentials never lapse", () => {
  const { root } = fixture(), store = join(root, "tokens.json");
  for (const scopes of [["inbox:write"], ["tend"], ["vault:read", "tend"]]) {
    const { token, record } = mintToken(store, root, scopes.join("+"), scopes, { via: scopes[0] === "inbox:write" ? "pair" : undefined });
    expect(verifyToken(store, token, at(record.created, 400)).ok).toBe(true);
  }
});

test("renewing keeps the id, the secret and the configuration, and restarts the clock", () => {
  const { root, clients } = fixture();
  const setup = clients.create({ name: "Studio Claude", kind: "claude-code" }), token = clients.token(setup.id);
  authenticateClient(root, token, "vault:read", clients.store);
  age(clients.store, setup.id, 31);
  const lastUsed = clients.list()[0]!.lastUsed;
  // Its credential and setup survive the lapse; presenting it names the fix and is noted.
  expect(clients.token(setup.id)).toBe(token);
  expect(clients.setup(setup.id).configuration).toEqual(setup.configuration);
  expect(() => authenticateClient(root, token, "vault:read", clients.store)).toThrow(ConnectionExpired);
  expect(() => authenticateClient(root, token, "inbox:write", clients.store)).toThrow(FIX);
  const lapsed = clients.list()[0]!;
  expect(lapsed).toMatchObject({ id: setup.id, expired: true, lastUsed });
  expect(lapsed.expiredUse).toBeTruthy();

  clients.renew(setup.id);
  expect(listTokens(clients.store)).toHaveLength(1);
  expect(clients.list()[0]).toMatchObject({ id: setup.id, expired: false, expiredUse: null, lastUsed, revoked: null });
  expect(clients.token(setup.id)).toBe(token);
  expect(authenticateClient(root, token, "vault:read", clients.store).id).toBe(setup.id);

  clients.revoke(setup.id);
  expect(() => clients.renew(setup.id)).toThrow("revoked");
  expect(() => clients.renew("00000000")).toThrow("not found");
});

test("clearing the notice forgets the attempt until the client tries again", () => {
  const { root, clients } = fixture();
  const setup = clients.create({ name: "Studio Claude", kind: "claude-code" }), token = clients.token(setup.id);
  age(clients.store, setup.id, 31);
  expect(clients.list()[0]).toMatchObject({ expired: true, expiredUse: null });
  expect(() => authenticateClient(root, token, "vault:read", clients.store)).toThrow(FIX);
  expect(clients.list()[0]!.expiredUse).toBeTruthy();
  clients.dismiss(setup.id);
  expect(clients.list()[0]).toMatchObject({ expired: true, expiredUse: null });
  noteExpiredUse(clients.store, setup.id);
  expect(clients.list()[0]!.expiredUse).toBeTruthy();
});

test("a lapsed MCP connection stays up and every tool answers with the fix until renewed", async () => {
  const { root, clients } = fixture();
  const setup = clients.create({ name: "Studio Codex", kind: "codex" });
  age(clients.store, setup.id, 31);
  const client = new Client({ name: "Studio Codex", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/mcp.ts"), "--client", setup.id], env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BIGBRAIN_VAULT: root, BIGBRAIN_TOKENS: clients.store }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(t => t.name);
    expect(tools).toEqual(["load_memory", "search_vault", "read_note", "drop"]);
    for (const name of tools) {
      const result = await client.callTool({ name, arguments: name === "drop" ? { title: "Lapsed", body: "Should not land." } : name === "read_note" ? { path: "memory/MEMORY.md" } : name === "search_vault" ? { query: "synthetic" } : {} });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toBe(FIX);
    }
    expect(readSourceInsertionLog(root)).toHaveLength(0);
    expect(clients.list()[0]).toMatchObject({ expired: true, lastUsed: null });
    expect(clients.list()[0]!.expiredUse).toBeTruthy();
    // Renewing in the app restores this same session; nothing in the client changes.
    clients.renew(setup.id);
    expect((await client.callTool({ name: "load_memory", arguments: {} })).isError).not.toBe(true);
    expect(clients.list()[0]!.lastUsed).toBeTruthy();
  } finally { await client.close(); }
});

test("the MCP server no longer takes a credential from its environment", async () => {
  const { root, clients } = fixture();
  const setup = clients.create({ name: "Env client", kind: "generic" });
  const client = new Client({ name: "Env client", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/mcp.ts")], env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BIGBRAIN_VAULT: root, BIGBRAIN_TOKENS: clients.store, BIGBRAIN_MCP_TOKEN: clients.token(setup.id) }, stderr: "pipe" });
  try {
    await client.connect(transport).catch(() => {});
    await expect(client.listTools()).rejects.toThrow();
    expect(clients.list()[0]!.lastUsed).toBeNull();
  } finally { await client.close(); }
});

test("the bearer API refuses a lapsed credential with where to renew it, and notes the attempt", async () => {
  const { root } = fixture(), store = join(root, "tokens.json");
  const reader = mintToken(store, root, "script", ["vault:read"]);
  const drop = mintToken(store, root, "extension", ["inbox:write"], { via: "pair" });
  let now = at(reader.record.created, 31);
  const handler = makeApiHandler({ root, storePath: store, log: () => {}, now: () => now });
  const get = (token: string) => handler(new Request("http://api.test/v1/status", { headers: { Authorization: `Bearer ${token}` } }));
  const res = await get(reader.token);
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe(`This BigBrain credential expired after 30 days unused. Renew it with \`bigbrain auth renew ${reader.record.id}\`.`);
  expect(listTokens(store).find(t => t.id === reader.record.id)).toMatchObject({ last_used: null, expired_use: now.toISOString() });
  // A guess at the secret learns nothing new.
  expect(await (await get(`bb_${reader.record.id}_guess`)).json()).toEqual({ error: "unauthorized" });
  const pairing = await handler(new Request("http://api.test/v1/drop?name=kept&poke=false", { method: "POST", headers: { Authorization: `Bearer ${drop.token}` }, body: "Still accepted." }));
  expect(pairing.status).toBe(200);
  renewToken(store, reader.record.id, now);
  now = at(reader.record.created, 32);
  expect((await get(reader.token)).status).toBe(200);
});

test("the legacy local Claude Code credential lapses too, and is listed, noticed and renewed in Connected clients", async () => {
  const { root, clients } = fixture();
  const legacy = mintToken(clients.store, root, "claude code on studio", ["inbox:write", "vault:read"], { kind: "agent", via: "connect" });
  mintToken(clients.store, root, "codex on studio", ["inbox:write", "vault:read"], { kind: "agent", via: "connect" });
  expect(clients.list().map(c => [c.name, c.kind, c.legacy, c.expired])).toEqual([["claude code on studio", "claude-code", true, false], ["codex on studio", "codex", true, false]]);
  age(clients.store, legacy.record.id, 31);
  // The old plugin reaches the vault over the bearer API.
  const handler = makeApiHandler({ root, storePath: clients.store, log: () => {} });
  const status = () => handler(new Request("http://api.test/v1/status", { headers: { Authorization: `Bearer ${legacy.token}` } }));
  const refused = await status();
  expect(refused.status).toBe(401);
  expect((await refused.json()).error).toBe(FIX);
  const lapsed = clients.list().find(c => c.id === legacy.record.id)!;
  expect(lapsed.expired).toBe(true);
  expect(lapsed.expiredUse).toBeTruthy();
  clients.renew(legacy.record.id);
  expect(clients.list().find(c => c.id === legacy.record.id)).toMatchObject({ expired: false, expiredUse: null });
  expect((await status()).status).toBe(200);
  // Replace still retires it once the named connection authenticates.
  const next = clients.replace(legacy.record.id);
  authenticateClient(root, clients.token(next.id), "vault:read", clients.store);
  expect(clients.list().find(c => c.id === legacy.record.id)!.revoked).toBeTruthy();
});

test("live integration access refuses a lapsed credential on its own, not only through bin/mcp.ts", () => {
  const { root, clients } = fixture();
  const id = clients.create({ name: "Reader", kind: "generic" }).id;
  const caller = { kind: "mcp" as const, token: clients.token(id), storePath: clients.store };
  expect(readableIntegrationAccounts(root, "email", caller)).toEqual([]);
  age(clients.store, id, 31);
  expect(() => readableIntegrationAccounts(root, "email", caller)).toThrow("Authenticate");
});
