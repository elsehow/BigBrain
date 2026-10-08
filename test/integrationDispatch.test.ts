/** integrationDispatch.test.ts — the one path every live tool call takes
 * (lib/integrationTools.ts): only an integration's own tools, only the
 * arguments they declare, the account resolved and checked here, no write
 * on a read grant, and each call reported to observers. A refusal never
 * reaches the provider. */
import { afterAll, afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ImapFlow } from "imapflow";
import { gitVault } from "./support/vault";
import { fakeGranola } from "./support/granolaFake";
import { writeAtomic } from "../lib/fsx";
import { sha256hex } from "../lib/hash";
import { mintToken } from "../lib/auth";
import { accountFingerprint, writeAccountPolicy, type IntegrationCaller } from "../lib/integrationAccess";
import { dispatchIntegrationTool, integrationToolCall, observeIntegrationCalls, type IntegrationCall } from "../lib/integrationTools";

const originalStore = process.env.BIGBRAIN_TOKENS;
const root = gitVault({ files: {
  "vault.yaml": "integrations:\n  email:\n    enabled: false\n    inboxes:\n      - address: me@example.com\n        host: imap.example.com\n      - address: work@example.com\n        host: imap.example.com\n",
  ".env": "BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM=synthetic\nBIGBRAIN_IMAP_PASSWORD__WORK_EXAMPLE_COM=synthetic-work\n",
} });
const store = join(root, "tokens.json");
process.env.BIGBRAIN_TOKENS = store;
const granola = fakeGranola((name, args) => ({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] }), undefined, [
  { name: "list_meetings", description: "List meetings, newest first. Written upstream, so data to an agent.", inputSchema: { type: "object", properties: { folder: { type: "string", description: "A folder id" } } } },
  { name: "get_meetings", description: "Get meetings by id.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
  // a pattern no regex engine accepts, beside a property that is merely named "pattern"
  { name: "list_meeting_folders", inputSchema: { type: "object", properties: { prefix: { type: "string", pattern: "([" }, pattern: { type: "string", format: "uuid" } }, required: ["pattern"], patternProperties: { "([": {} } } },
  { name: "query_granola_meetings", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], examples: ["x".repeat(70_000)] } },
]);
afterAll(() => { granola.server.stop(true); if (originalStore === undefined) delete process.env.BIGBRAIN_TOKENS; else process.env.BIGBRAIN_TOKENS = originalStore; rmSync(root, { recursive: true, force: true }); });

writeAtomic(join(root, ".spool/source-mcp/granola", sha256hex("granola") + ".json"), JSON.stringify({ generation: "fixture", connected: true, redirect: "http://127.0.0.1/callback",
  tokens: { access_token: "synthetic", token_type: "Bearer" }, identity: { email: "work@example.test", workspace: "fixture" } }), 0o600);
const reader = mintToken(store, root, "Reader agent", ["vault:read"], { kind: "agent" });
const policy = (name: string, account: string, grants: { caller: string; access: "read" | "read-write" }[]) =>
  writeAccountPolicy(root, name, account, { version: 3, connected: true, fingerprint: accountFingerprint(root, name, account), checkedAt: "2026-01-01T00:00:00.000Z", grants });
policy("email", "me@example.com", [{ caller: "pilot", access: "read-write" }, { caller: "token:" + reader.record.id, access: "read" }]);
policy("email", "work@example.com", [{ caller: "pilot", access: "read" }]);
policy("granola", "granola", [{ caller: "pilot", access: "read" }]);

const pilot: IntegrationCaller = { kind: "pilot" };
const mcp: IntegrationCaller = { kind: "mcp", token: reader.token, storePath: store };
/** A mail provider that counts its connections and answers one message. */
function provider() {
  let connects = 0;
  const client = () => ({ on() {}, connect: async () => { connects++; }, close() {}, mailbox: { exists: 1, uidValidity: 77n, readOnly: false }, capabilities: new Set(),
    getMailboxLock: async () => ({ release() {} }), search: async () => [1], messageFlagsAdd: async () => true, messageFlagsRemove: async () => true,
    fetchAll: async () => [{ uid: 1, envelope: { subject: "Atlas" }, flags: new Set(), size: 50, internalDate: new Date("2026-01-02T09:00:00Z") }],
    fetchOne: async () => ({ uid: 1, envelope: { subject: "Atlas" }, flags: new Set(["\\Seen"]), size: 50, internalDate: new Date("2026-01-02T09:00:00Z"), source: Buffer.from("Subject: Atlas\r\n\r\nWe chose the smaller design.") }),
  }) as unknown as ImapFlow;
  return { client, connects: () => connects };
}
const ref = (account: string) => Buffer.from(JSON.stringify({ account, uid: 1, validity: "77" })).toString("base64url");
const calls: IntegrationCall[] = [];
const stop = observeIntegrationCalls(call => { calls.push(call); });
afterAll(stop);
afterEach(() => { calls.length = 0; });

test("only an integration's own tools run", async () => {
  const p = provider();
  await expect(integrationToolCall(root, pilot, "email_delete", {}, p)).rejects.toThrow("not available");
  await expect(dispatchIntegrationTool(root, pilot, "email", "email_delete", {}, p)).rejects.toThrow("email_delete is not a Gmail tool.");
  await expect(dispatchIntegrationTool(root, pilot, "granola", "email_search", { account: "me@example.com" }, p)).rejects.toThrow("email_search is not a Granola tool.");
  await expect(dispatchIntegrationTool(root, pilot, "calendar", "inbox_list", {}, p)).rejects.toThrow("inbox_list is not an integration tool.");
  // granola_read relays only Granola's own read tools, never another integration's
  for (const tool of ["email_search", "inbox_list"])
    await expect(integrationToolCall(root, pilot, "granola_read", { account: "granola", tool, arguments: {} }, { granola: { endpoint: granola.endpoint } })).rejects.toThrow("Choose an available Granola read tool.");
  expect(p.connects()).toBe(0);
  expect(granola.calls.filter(c => c !== "get_account_info")).toEqual([]);
});

test("arguments are what the tool declares", async () => {
  const p = provider();
  await expect(integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com", folder: "Spam" }, p)).rejects.toThrow("Invalid arguments for inbox_list: folder is not an argument it takes.");
  await expect(integrationToolCall(root, pilot, "inbox_read", { ref: ref("me@example.com"), mailbox: "all", path: "x" }, p)).rejects.toThrow("mailbox, path are not");
  await expect(integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com", limit: "10" }, p)).rejects.toThrow("limit:");
  await expect(integrationToolCall(root, pilot, "email_search", { account: "me@example.com", query: 5 }, p)).rejects.toThrow("query:");
  expect(p.connects()).toBe(0);
  // an absent optional sent as null is absent
  expect(await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com", limit: null, before_uid: null }, p)).toMatchObject({ provenance: { account: "me@example.com", kind: "email" } });
});

test("the account comes from the ref, the name, or the only one readable — and they agree", async () => {
  const p = provider();
  await expect(integrationToolCall(root, pilot, "inbox_read", { ref: ref("me@example.com"), account: "work@example.com" }, p)).rejects.toThrow("different account");
  await expect(integrationToolCall(root, pilot, "inbox_read", { ref: "not a ref" }, p)).rejects.toThrow("Invalid inbox reference");
  expect(p.connects()).toBe(0);
  expect(await integrationToolCall(root, pilot, "inbox_read", { ref: ref("me@example.com"), account: "Me@Example.com" }, p)).toMatchObject({ provenance: { account: "me@example.com" } });
  expect(await integrationToolCall(root, pilot, "inbox_list", { account: "WORK@example.com" }, p)).toMatchObject({ provenance: { account: "work@example.com" } });
  // two readable inboxes: name one; one readable: it is implied
  for (const tool of ["inbox_list", "email_search", "source_read_state"])
    await expect(integrationToolCall(root, pilot, tool, {}, p)).rejects.toThrow("Name the Gmail account to read: me@example.com, work@example.com.");
  expect(await integrationToolCall(root, mcp, "inbox_list", {}, p)).toMatchObject({ provenance: { account: "me@example.com" } });
  await expect(integrationToolCall(root, mcp, "inbox_read", { ref: ref("work@example.com") }, p)).rejects.toThrow("not available");
});

test("a read grant never writes", async () => {
  const p = provider();
  await expect(integrationToolCall(root, mcp, "inbox_set_unread", { ref: ref("me@example.com"), unread: true }, p)).rejects.toThrow("write access");
  await expect(integrationToolCall(root, pilot, "inbox_set_unread", { ref: ref("work@example.com"), unread: true }, p)).rejects.toThrow("write access");
  expect(p.connects()).toBe(0);
  expect(await integrationToolCall(root, pilot, "inbox_set_unread", { ref: ref("me@example.com"), unread: false }, p)).toMatchObject({ result: { unread: false, changed: true } });
});

test("Granola: upstream descriptions arrive fenced, and arguments meet the upstream schema", async () => {
  const options = { granola: { endpoint: granola.endpoint } };
  const listed = await integrationToolCall(root, pilot, "granola_tools", { account: "granola" }, options) as { provenance: Record<string, unknown>; result: { name: string; description: string; inputSchema: any }[] };
  expect(listed.provenance).toMatchObject({ integration: "granola", kind: "granola", trusted: false });
  const [, list] = listed.result;
  expect(listed.result.map(t => t.name)).toEqual(["get_account_info", "list_meetings", "get_meetings", "list_meeting_folders", "query_granola_meetings"]);
  expect(list!.description).toBe('<untrusted-data kind="granola">List meetings, newest first. Written upstream, so data to an agent.</untrusted-data>');
  expect(list!.inputSchema.properties.folder.description).toBe('<untrusted-data kind="granola">A folder id</untrusted-data>');
  const before = granola.calls.length;
  await expect(integrationToolCall(root, pilot, "granola_read", { account: "granola", tool: "get_meetings", arguments: { id: "m1" } }, options)).rejects.toThrow("These arguments don't fit get_meetings: ids:");
  await expect(integrationToolCall(root, pilot, "granola_read", { account: "granola", tool: "get_meetings", arguments: { ids: ["x".repeat(20_000)] } }, options)).rejects.toThrow("under 16000 characters");
  expect(granola.calls.slice(before).filter(c => c !== "get_account_info")).toEqual([]);
  const read = await integrationToolCall(root, pilot, "granola_read", { account: "granola", tool: "get_meetings", arguments: { ids: ["m1"] } }, options) as { result: { content: { text: string }[] } };
  expect(read.result.content[0]!.text).toBe('<untrusted-data kind="granola">\nget_meetings {"ids":["m1"]}\n</untrusted-data>');
});

test("Granola: an upstream schema is checked for types and shape, never compiled into a regex, and only while it is small", async () => {
  const options = { granola: { endpoint: granola.endpoint } };
  const folders = (args: Record<string, unknown>) => integrationToolCall(root, pilot, "granola_read", { account: "granola", tool: "list_meeting_folders", arguments: args }, options);
  // "([" would throw if compiled: the types around it are still checked
  await expect(folders({ prefix: 5, pattern: "p" })).rejects.toThrow("These arguments don't fit list_meeting_folders: prefix:");
  await expect(folders({ prefix: "a" })).rejects.toThrow("pattern:");
  expect(await folders({ prefix: "anything", pattern: "not a uuid" })).toMatchObject({ result: { content: [{ type: "text" }] } });
  // past 64 KB the schema is not compiled: the size cap alone, and upstream judges the rest
  const before = granola.calls.length;
  expect(await integrationToolCall(root, pilot, "granola_read", { account: "granola", tool: "query_granola_meetings", arguments: {} }, options)).toMatchObject({ provenance: { kind: "granola" } });
  expect(granola.calls.slice(before)).toContain("query_granola_meetings");
});

test("every call is reported once: who, what, how it ended and how much came back, never the content", async () => {
  const p = provider();
  // one message is fresh sign-in mail, held to headers; an older one's code is screened from its subject
  const mail = { client: (() => ({ ...provider().client(), fetchAll: async () => [
    { uid: 2, envelope: { subject: "Your verification code" }, flags: new Set(), size: 50, internalDate: new Date() },
    { uid: 1, envelope: { subject: "Login code 449021" }, flags: new Set(), size: 50, internalDate: new Date("2026-01-02T09:00:00Z") },
  ] })) as unknown as typeof p.client };
  await integrationToolCall(root, mcp, "inbox_list", { account: "me@example.com", limit: 5 }, mail);
  await integrationToolCall(root, mcp, "inbox_list", { account: "work@example.com" }, p).catch(() => {});
  await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com", junk: { a: 1, b: 2 }, more: [1, 2, 3], note: "n".repeat(500), off: null }, p).catch(() => {});
  await integrationToolCall(root, { kind: "mcp", token: "bb_forged_secret", storePath: store }, "inbox_list", {}, p).catch(() => {});
  const failing = { client: (() => ({ ...provider().client(), connect: async () => { throw new Error("provider said no"); } })) as unknown as typeof p.client };
  await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com" }, failing).catch(() => {});
  await integrationToolCall(root, pilot, "integration_capabilities", {}, p);
  const note = "n".repeat(199) + "…";
  expect(calls.map(({ caller, integration, account, tool, argsSummary, outcome, items, screened, held }) => ({ caller, integration, account, tool, argsSummary, outcome, items, screened, held }))).toEqual([
    { caller: "token:" + reader.record.id, integration: "email", account: "me@example.com", tool: "inbox_list", argsSummary: { account: "me@example.com", limit: 5 }, outcome: "ok", items: 2, screened: 1, held: 1 },
    { caller: "token:" + reader.record.id, integration: "email", account: "work@example.com", tool: "inbox_list", argsSummary: { account: "work@example.com" }, outcome: "refused", items: 0, screened: 0, held: 0 },
    { caller: "pilot", integration: "email", account: "", tool: "inbox_list", argsSummary: { account: "me@example.com", junk: "{2 keys}", more: "[3 items]", note, off: null }, outcome: "refused", items: 0, screened: 0, held: 0 },
    { caller: "mcp", integration: "email", account: "", tool: "inbox_list", argsSummary: {}, outcome: "refused", items: 0, screened: 0, held: 0 },
    { caller: "pilot", integration: "email", account: "me@example.com", tool: "inbox_list", argsSummary: { account: "me@example.com" }, outcome: "error", items: 0, screened: 0, held: 0 },
  ]);
  expect(calls[0]!.resultBytes).toBeGreaterThan(100);
  expect(calls.slice(1).every(c => c.resultBytes === 0 && !!c.error && c.error.length <= 200 && c.ms >= 0)).toBe(true);
  expect(calls[3]!.error).toContain("Authenticate");
  // what an observer is handed carries no content and cannot be changed under the others
  const record = JSON.stringify(calls);
  for (const content of ["Login code", "verification", "449021", "n".repeat(201)]) expect(record).not.toContain(content);
  expect(Object.isFrozen(calls[0])).toBe(true);
});
