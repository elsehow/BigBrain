/** integrationSurface.test.ts — what agents are offered from live integrations,
 * pinned. The MCP and Pilot tool definitions (each as the exact JSON a client
 * receives), the capabilities they report, the Settings and library rows, and
 * who may read or write which account. A refactor of where integrations are
 * declared must leave every snapshot here unchanged; a change to the surface
 * itself updates them on purpose. Lists are keyed by tool name: their order is
 * presentation, the definitions are the contract. */
import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gitVault } from "./support/vault";
import { writeAtomic } from "../lib/fsx";
import { sha256hex } from "../lib/hash";
import { mintToken } from "../lib/auth";
import { mcpToolList } from "../lib/mcp";
import { pilotTools } from "../lib/pilot";
import { pilotChatTools } from "../lib/pilotChat";
import { integrationCapabilities } from "../lib/integrationTools";
import { liveOrigin } from "../lib/agentReads";
import { configuredAccounts } from "../lib/integrationAccounts";
import { integrationLibrary } from "../lib/integrationLibrary";
import { accountFingerprint, integrationAccountEnvKey, integrationAccounts, integrationFingerprint, MANAGED_INTEGRATIONS,
  readableIntegrationAccounts, requireIntegrationRead, requireIntegrationWrite, writableIntegrationAccounts, writeAccountPolicy, type IntegrationCaller } from "../lib/integrationAccess";

const originalStore = process.env.BIGBRAIN_TOKENS;
const root = gitVault({ files: {
  "vault.yaml": "integrations:\n  email:\n    enabled: false\n    inboxes:\n      - address: me@example.com\n        host: imap.example.com\n      - address: work@example.com\n        host: imap.gmail.com\n        provider: gmail\n  rss:\n    feeds:\n      - url: https://feeds.example.com/news.xml\n        title: Example news\n",
  ".env": "BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM=synthetic\nBIGBRAIN_IMAP_PASSWORD__WORK_EXAMPLE_COM=synthetic-work\nTHAT_TRACKS_API_KEY=synthetic-tracks\n",
} });
const store = join(root, "tokens.json");
process.env.BIGBRAIN_TOKENS = store;
afterAll(() => { if (originalStore === undefined) delete process.env.BIGBRAIN_TOKENS; else process.env.BIGBRAIN_TOKENS = originalStore; rmSync(root, { recursive: true, force: true }); });

// Granola: the built-in account and one added account, each with a synthetic sign-in.
const extra = "account-0123456789abcdef";
mkdirSync(join(root, ".spool/integration-accounts/granola"), { recursive: true });
writeFileSync(join(root, ".spool/integration-accounts/granola/accounts.json"), JSON.stringify([{ id: extra, label: "Second workspace" }]));
for (const account of ["granola", extra]) writeAtomic(join(root, ".spool/source-mcp/granola", sha256hex(account) + ".json"),
  JSON.stringify({ generation: "fixture-" + account, connected: true, redirect: "http://127.0.0.1/callback", tokens: { access_token: "synthetic", token_type: "Bearer" }, identity: { workspace: "fixture" } }), 0o600);

const writer = mintToken(store, root, "Writer agent", ["vault:read", "inbox:write"], { kind: "agent" });
const reader = mintToken(store, root, "Reader agent", ["vault:read"], { kind: "agent" });
const stranger = mintToken(store, root, "Ungranted agent", ["vault:read"], { kind: "agent" });
const W = "token:" + writer.record.id, R = "token:" + reader.record.id;
const policy = (name: string, account: string, grants: { caller: string; access: "off" | "read" | "read-write" }[], liveAccess?: boolean) =>
  writeAccountPolicy(root, name, account, { version: 2, connected: true, fingerprint: accountFingerprint(root, name, account), checkedAt: "2026-01-01T00:00:00.000Z", grants, ...(liveAccess === undefined ? {} : { liveAccess }) });
policy("email", "me@example.com", [{ caller: "pilot", access: "read-write" }, { caller: W, access: "read-write" }, { caller: R, access: "read" }]);
policy("email", "work@example.com", [{ caller: "pilot", access: "read" }, { caller: W, access: "read-write" }, { caller: R, access: "read" }]);
policy("granola", "granola", [{ caller: "pilot", access: "read" }, { caller: W, access: "read" }, { caller: R, access: "read" }]);
policy("granola", extra, [], true);
policy("that-tracks", "that-tracks", [{ caller: "pilot", access: "off" }]);
policy("rss", "https://feeds.example.com/news.xml", [], false);

const mcp = (token?: string): IntegrationCaller => ({ kind: "mcp", token, storePath: store });
const callers: Record<string, IntegrationCaller> = {
  pilot: { kind: "pilot" }, writer: mcp(writer.token), reader: mcp(reader.token), stranger: mcp(stranger.token), unauthenticated: mcp(),
  gardener: { kind: "gardener" }, worker: { kind: "worker", accounts: [{ integration: "email", account: "work@example.com" }, { integration: "granola", account: extra }] },
};
/** Each definition as the JSON a client receives, keyed by name. */
const definitions = (tools: { name: string }[]) => Object.fromEntries(tools.map(t => [t.name, JSON.stringify(t)]));
const outcome = (f: () => unknown) => { try { return f() ?? "ok"; } catch (e) { return "refused: " + (e as Error).message; } };
/** As JSON, with the minted token ids named, so the snapshot holds across runs. */
const named = (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(writer.record.id, "writer").replaceAll(reader.record.id, "reader"));

test("MCP lists live tools by what the client may do", () => {
  const list = (token?: string) => mcpToolList({ root, via: "cli", integrationToken: token, tokenStore: store });
  expect(definitions(list(writer.token))).toMatchSnapshot("email + granola, with write");
  expect(definitions(list(reader.token))).toMatchSnapshot("email + granola, read only");
  // granted nothing itself, it still reads the account whose liveAccess decides for every caller
  expect(list(stranger.token).map(t => t.name).sort()).toMatchSnapshot("no grants of its own");
  expect(list().map(t => t.name).sort()).toMatchSnapshot("no credential");
});

test("Pilot is offered every live tool, read and write", () => {
  expect(definitions(pilotTools())).toMatchSnapshot("pilot realtime tools");
  expect(definitions(pilotChatTools())).toMatchSnapshot("pilot chat tools");
});

test("capabilities and access decisions per caller", () => {
  const names = [...MANAGED_INTEGRATIONS];
  expect(names).toMatchSnapshot("managed integrations, in order");
  for (const [who, caller] of Object.entries(callers)) {
    expect(outcome(() => integrationCapabilities(root, caller))).toMatchSnapshot(`capabilities: ${who}`);
    const decisions = Object.fromEntries(names.map(name => [name, {
      readable: outcome(() => readableIntegrationAccounts(root, name, caller)),
      writable: outcome(() => writableIntegrationAccounts(root, name, caller)),
      accounts: Object.fromEntries(integrationAccounts(root, name).map(account => [account, {
        read: outcome(() => requireIntegrationRead(root, name, account, caller)),
        write: outcome(() => requireIntegrationWrite(root, name, account, caller)),
      }])),
    }]));
    expect(decisions).toMatchSnapshot(`access: ${who}`);
  }
});

test("accounts, credentials and library rows", () => {
  const names = [...MANAGED_INTEGRATIONS];
  expect(named(configuredAccounts(root))).toMatchSnapshot("settings rows");
  expect(integrationLibrary(root)).toMatchSnapshot("library");
  expect(Object.fromEntries(names.map(name => [name, {
    fingerprint: integrationFingerprint(root, name),
    accounts: Object.fromEntries(integrationAccounts(root, name).map(a => [a, accountFingerprint(root, name, a)])),
  }]))).toMatchSnapshot("fingerprints");
  expect(["granola", "that-tracks"].flatMap(name => [name, extra].map(a => integrationAccountEnvKey(name, a)))).toMatchSnapshot("credential env keys");
  const tools = pilotTools().map(t => t.name);
  expect(Object.fromEntries(tools.map(name => [name, liveOrigin(name) ?? null]))).toMatchSnapshot("live origins");
});
