/** readLog.test.ts — the host-side record of live integration calls
 * (lib/readLog.ts): one line per call, with who asked and how it ended, never
 * what came back or a credential; owner-only, monthly, pruned after 90 days;
 * safe for several processes to append to; and never the reason a read fails.
 * Settings reads it through the viewer, behind its session. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ImapFlow } from "imapflow";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gitVault, nativeVault, NATIVE_YAML } from "./support/vault";
import { viewerAuth, viewerHome } from "./support/viewerSession";
import { configDir } from "../lib/engine";
import { sha256hex } from "../lib/hash";
import { ConnectedClients } from "../lib/connectedClients";
import { accountFingerprint, writeAccountPolicy, type IntegrationCaller } from "../lib/integrationAccess";
import { integrationToolCall } from "../lib/integrationTools";
import { appendRead, lastReads, loggedArgs, logIntegrationCalls, mcpParent, readLogDir, readRecord, recentReads, type ReadRecord } from "../lib/readLog";
import type { IntegrationCall } from "../lib/integrationTools";

const dirs: string[] = [];
const scratch = (prefix = "bb-reads-"): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const originalLog = process.env.BIGBRAIN_READ_LOG, originalStore = process.env.BIGBRAIN_TOKENS;
const root = gitVault({ files: {
  "vault.yaml": "integrations:\n  email:\n    enabled: false\n    inboxes:\n      - address: me@example.com\n        host: imap.example.com\n",
  ".env": "BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM=synthetic\n",
} });
dirs.push(root);
const store = join(root, "tokens.json");
process.env.BIGBRAIN_TOKENS = store;
writeAccountPolicy(root, "email", "me@example.com", { version: 2, connected: true, fingerprint: accountFingerprint(root, "email", "me@example.com"), checkedAt: "2026-01-01T00:00:00.000Z", grants: [{ caller: "pilot", access: "read" }] });
const stop = logIntegrationCalls(root);
afterAll(() => {
  stop();
  if (originalLog === undefined) delete process.env.BIGBRAIN_READ_LOG; else process.env.BIGBRAIN_READ_LOG = originalLog;
  if (originalStore === undefined) delete process.env.BIGBRAIN_TOKENS; else process.env.BIGBRAIN_TOKENS = originalStore;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
let log = "";
beforeEach(() => { log = process.env.BIGBRAIN_READ_LOG = scratch(); });

const pilot: IntegrationCaller = { kind: "pilot" };
const ref = Buffer.from(JSON.stringify({ account: "me@example.com", uid: 1, validity: "77" })).toString("base64url");
/** A mail provider with one message: an old one by default, whose body carries a sign-in code and secret-looking text. */
const provider = (message: { subject: string; body: string; at?: Date } = { subject: "Atlas", body: "We chose the smaller design. Your verification code is 482913.\nSECRET-BODY-MARKER sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234" }, connect = async () => {}) => ({
  client: () => ({ on() {}, connect, close() {}, mailbox: { exists: 1, uidValidity: 77n, readOnly: true }, capabilities: new Set(),
    getMailboxLock: async () => ({ release() {} }), search: async () => [1],
    fetchAll: async () => [{ uid: 1, envelope: { subject: message.subject, from: [{ address: "sender@example.com" }] }, flags: new Set(), size: 50, internalDate: message.at ?? new Date("2026-01-02T09:00:00Z") }],
    fetchOne: async () => ({ uid: 1, envelope: { subject: message.subject, from: [{ address: "sender@example.com" }] }, flags: new Set(["\\Seen"]), size: 50, internalDate: message.at ?? new Date("2026-01-02T09:00:00Z"),
      source: Buffer.from(`Subject: ${message.subject}\r\nFrom: sender@example.com\r\n\r\n${message.body}`) }),
  }) as unknown as ImapFlow,
});
const month = (): string => readdirSync(log).find(n => /^\d{4}-\d{2}\.jsonl$/.test(n))!;
const lines = (): ReadRecord[] => readFileSync(join(log, month()), "utf8").trim().split("\n").map(l => JSON.parse(l));

test("a read is one line: who, what, how it ended, how much came back", async () => {
  await integrationToolCall(root, pilot, "inbox_read", { ref }, provider());
  const [r] = lines();
  expect(r).toMatchObject({ caller: "pilot", label: "Pilot", integration: "email", account: "me@example.com", tool: "inbox_read", args: { ref }, outcome: "ok", first: true });
  expect(Object.keys(r!).sort()).toEqual(["account", "args", "caller", "first", "held", "integration", "items", "label", "ms", "outcome", "resultBytes", "screened", "tool", "ts"]);
  expect(Date.parse(r!.ts)).toBeGreaterThan(Date.now() - 60_000);
  expect(r!.resultBytes).toBeGreaterThan(100);
  expect(typeof r!.items).toBe("number");
  expect(r!.screened).toBeGreaterThanOrEqual(1); // the code the screen withheld
  expect(r!.held).toBe(0);
  expect(month()).toBe(`${r!.ts.slice(0, 7)}.jsonl`);
});

test("nothing that came back reaches the file, nor a credential the arguments carried", async () => {
  await integrationToolCall(root, pilot, "inbox_read", { ref }, provider());
  await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com", limit: 5 }, provider());
  await expect(integrationToolCall(root, pilot, "email_search", { account: "me@example.com", query: "from:bank bb_0123abcd_SyntheticSecretValue123 api_key=FAKE-KEY-9876" }, provider())).rejects.toThrow();
  const text = readdirSync(log).map(n => readFileSync(join(log, n), "utf8")).join("\n");
  for (const leaked of ["Atlas", "smaller design", "482913", "SECRET-BODY-MARKER", "sk-live", "sender@example.com", "bb_0123abcd", "SyntheticSecretValue123", "FAKE-KEY-9876"])
    expect(text).not.toContain(leaked);
  expect(lines().map(r => r.tool)).toEqual(["inbox_read", "inbox_list", "email_search"]);
});

test("fresh sign-in mail held back is counted, not kept", async () => {
  await integrationToolCall(root, pilot, "inbox_read", { ref }, provider({ subject: "Your sign-in code", body: "Use 731904 to sign in.", at: new Date() }));
  const [r] = lines();
  expect(r!.held).toBe(1);
  expect(JSON.stringify(r)).not.toContain("731904");
});

test("the dispatcher's argument summary is logged with credential shapes withheld again; refs kept", () => {
  const s = loggedArgs({ query: "q".repeat(199) + "…", ref, meeting_id: "m-1", limit: 10, arguments: "{2 keys}", off: null,
    note: "password: hunter2x and Bearer abcdefghijklmnop1234 and ghp_ABCDEFGHIJKLMNOPQRSTUV and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", opaque: ref });
  expect(s).toMatchObject({ query: "q".repeat(199) + "…", ref, meeting_id: "m-1", limit: 10, arguments: "{2 keys}", off: null, opaque: "[withheld]" });
  for (const secret of ["hunter2x", "abcdefghijklmnop1234", "ghp_", "eyJhbGci"]) expect(String(s.note)).not.toContain(secret);
  expect(loggedArgs({ query: "invoice from example.com 2026" })).toEqual({ query: "invoice from example.com 2026" });
  // a summary too long for one line is clipped harder, then left out
  const call: IntegrationCall = { at: "2026-10-07T12:00:00.000Z", caller: "pilot", integration: "email", account: "me@example.com", tool: "email_search", outcome: "refused", ms: 1, resultBytes: 0, items: 0, screened: 0, held: 0,
    argsSummary: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "w ".repeat(99) + "…"])) };
  expect(Object.values(readRecord(call, { label: "Pilot" }).args).every(v => String(v).length === 41)).toBe(true);
  // control characters take six bytes each in JSON
  const wide = "\u0001".repeat(199) + "…";
  expect(readRecord({ ...call, argsSummary: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}${wide}`, wide])) }, { label: "Pilot" }).args).toEqual({ "…": "arguments too long to log" });
});

test("refusals and failures are logged, their errors clipped and screened", async () => {
  await expect(integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com", folder: "Spam" }, provider())).rejects.toThrow("folder is not an argument");
  await expect(integrationToolCall(root, { kind: "gardener" }, "inbox_list", { account: "Me@Example.com" }, provider())).rejects.toThrow("Gardener");
  await expect(integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com" }, provider(undefined, async () => { throw new Error("connection refused"); }))).rejects.toThrow("Live inbox read failed");
  const [refused, gardener, failed] = lines();
  expect(refused).toMatchObject({ caller: "pilot", account: "", args: { account: "me@example.com", folder: "Spam" }, outcome: "refused" });
  expect(refused!.error).toContain("folder is not an argument it takes");
  expect(refused).not.toHaveProperty("resultBytes");
  expect(gardener).toMatchObject({ caller: "gardener", label: "Gardener", outcome: "refused" });
  expect(failed).toMatchObject({ caller: "pilot", account: "me@example.com", outcome: "error", error: "Live inbox read failed or timed out. Check the inbox connection; no mail was changed." });
  // whatever a provider's error says, the log keeps 200 characters of it, credentials withheld
  const said = readRecord({ at: failed!.ts, caller: "pilot", integration: "email", account: "me@example.com", tool: "inbox_list", argsSummary: {}, outcome: "error", ms: 1, resultBytes: 0, items: 0, screened: 0, held: 0,
    error: `login failed for abcd efgh ijkl mnop; password: hunter2x; token sk-proj-ABCDEFGHIJKLMNOPQRSTUV ${"x".repeat(600)}` }, { label: "Pilot" }).error!;
  for (const secret of ["abcd efgh", "hunter2x", "sk-proj"]) expect(said).not.toContain(secret);
  expect(said.startsWith("login failed for [withheld]")).toBe(true);
  expect(said.length).toBe(201);
  // under the account it named, though refused before one was resolved
  expect(recentReads(root, "email", "me@example.com").map(r => r.outcome)).toEqual(["error", "refused", "refused"]);
});

test("a caller's first read of an integration is marked, and remembered after its month is pruned", async () => {
  await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com" }, provider());
  await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com" }, provider());
  const reads = recentReads(root, "email", "me@example.com");
  expect(reads.map(r => !!r.first)).toEqual([false, true]);
  expect(lastReads(root, ["pilot"]).get("pilot")).toEqual({ ts: reads[0]!.ts, integration: "email" });
  // a log whose first read is in a pruned month: later reads are not first
  log = process.env.BIGBRAIN_READ_LOG = scratch();
  writeFileSync(join(log, "firsts.jsonl"), JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", caller: "pilot", integration: "email" }) + "\n");
  await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com" }, provider());
  expect(lines()[0]).not.toHaveProperty("first");
  expect(recentReads(root, "email", "me@example.com").some(r => r.first)).toBe(false);
});

test("owner-only: the folder 0700, the files 0600", async () => {
  log = process.env.BIGBRAIN_READ_LOG = join(scratch(), "reads", "abc");
  await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com" }, provider());
  expect(statSync(log).mode & 0o777).toBe(0o700);
  expect(statSync(join(log, "..")).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(log)) expect(statSync(join(log, name)).mode & 0o777).toBe(0o600);
  expect(readdirSync(log).sort()).toEqual(["firsts.jsonl", month()].sort());
});

test("one file a month; months that ended over 90 days ago are pruned as it writes", () => {
  const record = (ts: string): ReadRecord => ({ ts, caller: "pilot", label: "Pilot", integration: "email", account: "me@example.com", tool: "inbox_list", args: {}, outcome: "refused", ms: 1 });
  for (const old of ["2026-06.jsonl", "2026-07.jsonl", "notes.txt"]) writeFileSync(join(log, old), "");
  const now = Date.UTC(2026, 9, 7);
  appendRead(log, record("2026-09-30T23:59:59.999Z"), now);
  appendRead(log, record("2026-10-01T00:00:00.000Z"), now);
  // June ended 98 days before; July 68
  expect(readdirSync(log).sort()).toEqual(["2026-07.jsonl", "2026-09.jsonl", "2026-10.jsonl", "notes.txt"]);
  expect(readFileSync(join(log, "2026-09.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
});

test("each caller's last read is found without reading the whole log", () => {
  const line = (caller: string, ts: string, outcome: ReadRecord["outcome"] = "ok") =>
    JSON.stringify({ ts, caller, label: caller, integration: "email", account: "me@example.com", tool: "inbox_list", args: {}, outcome, ms: 1 });
  writeFileSync(join(log, "2026-10.jsonl"), [line("token:aaaa0001", "2026-10-01T00:00:00.000Z"), line("pilot", "2026-10-02T00:00:00.000Z"), line("pilot", "2026-10-03T00:00:00.000Z", "refused")].join("\n") + "\n");
  // an older month: one client's read behind 5,000 lines of others' refusals, another's after
  writeFileSync(join(log, "2026-09.jsonl"), [line("token:bbbb0002", "2026-09-01T00:00:00.000Z"), ...Array.from({ length: 5_000 }, () => line("token:cccc0003", "2026-09-02T00:00:00.000Z", "refused")),
    line("token:dddd0004", "2026-09-03T00:00:00.000Z")].join("\n") + "\n");
  // stops once everyone asked for is found
  expect([...lastReads(root, ["pilot"]).keys()]).toEqual(["pilot"]);
  expect(lastReads(root, ["pilot", "token:aaaa0001"]).get("pilot")).toEqual({ ts: "2026-10-02T00:00:00.000Z", integration: "email" });
  // reads the newest month whole, then 5,000 lines more at most
  const far = lastReads(root, ["pilot", "token:bbbb0002", "token:dddd0004"]);
  expect([...far.keys()].sort()).toEqual(["pilot", "token:aaaa0001", "token:dddd0004"]);
});

test("two processes appending at once leave whole lines", async () => {
  const writer = join(import.meta.dir, "support", "readLogWriter.ts");
  const run = (tag: string) => Bun.spawn([process.execPath, writer, log, tag, "400"], { stdout: "ignore", stderr: "pipe" });
  const [a, b] = [run("alpha"), run("bravo")];
  expect(await a.exited).toBe(0);
  expect(await b.exited).toBe(0);
  const text = readFileSync(join(log, "2026-10.jsonl"), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  const all = text.trim().split("\n").map(l => JSON.parse(l) as ReadRecord);
  expect(all).toHaveLength(800);
  for (const tag of ["alpha", "bravo"]) expect(all.filter(r => r.label === tag && String(r.args.query).startsWith(tag)).length).toBe(400);
});

test("a log that cannot be written never fails the read, and says so once", async () => {
  const blocker = join(scratch(), "a-file");
  writeFileSync(blocker, "");
  process.env.BIGBRAIN_READ_LOG = join(blocker, "reads");
  const said: string[] = [], error = console.error;
  console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
  try {
    for (let i = 0; i < 2; i++)
      expect(await integrationToolCall(root, pilot, "inbox_list", { account: "me@example.com" }, provider())).toMatchObject({ provenance: { account: "me@example.com" } });
  } finally { console.error = error; }
  expect(said.filter(s => s.startsWith("read log:"))).toHaveLength(1);
});

test("bigbrain mcp logs its client's calls, with the client's name and the program that started it", async () => {
  const id = new ConnectedClients(root, store).create({ name: "Sample client", kind: "generic" }).id;
  const client = new Client({ name: "sample", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/mcp.ts"), "--client", id],
    env: { ...process.env, BIGBRAIN_VAULT: root, BIGBRAIN_TOKENS: store, BIGBRAIN_READ_LOG: log } as Record<string, string>, stderr: "pipe" }));
  try {
    expect((await client.callTool({ name: "inbox_list", arguments: { account: "me@example.com", folder: "Spam" } })).isError).toBe(true);
  } finally { await client.close(); }
  const [r] = lines();
  expect(r).toMatchObject({ caller: `token:${id}`, label: "Sample client", tool: "inbox_list", outcome: "refused" });
  expect(r!.parent!.pid).toBeGreaterThan(0);
  expect(typeof r!.parent!.command).toBe("string");
  expect(mcpParent()).toEqual(mcpParent()); // asked once, then kept
});

test("the log is the vault's own under ~/.config/bigbrain/reads, as the token store is", () => {
  delete process.env.BIGBRAIN_READ_LOG;
  try { expect(readLogDir(root)).toBe(join(configDir(), "reads", sha256hex(root).slice(0, 12))); }
  finally { process.env.BIGBRAIN_READ_LOG = log; }
});

test("the viewer serves it read-only, and only with its session", async () => {
  appendRead(log, { ts: "2026-10-07T12:00:00.000Z", caller: "token:0123abcd", label: "Sample client", integration: "email", account: "me@example.com", tool: "email_search", args: { query: "invoice" }, outcome: "ok", ms: 12, resultBytes: 900, items: 3, screened: 0, held: 0 });
  const home = viewerHome(), vault = nativeVault({ files: { "vault.yaml": NATIVE_YAML } });
  dirs.push(home, vault);
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }), port = probe.port!;
  probe.stop(true);
  const child = Bun.spawn([process.execPath, "web/server.ts"], {
    env: { ...process.env, HOME: home, BIGBRAIN_VAULT: vault, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_SUPERVISOR_PID: "", BIGBRAIN_READ_LOG: log, NODE_ENV: "test" },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(url("/api/engine"), { headers: viewerAuth(home, port) })).ok) break; } catch { /* starting */ }
      await Bun.sleep(40);
    }
    const reads = "/api/integration-reads?integration=email&account=me%40example.com";
    for (const path of [reads, "/api/integration-reads/callers"]) expect((await fetch(url(path))).status).toBe(401);
    const r = await fetch(url(reads), { headers: viewerAuth(home, port) });
    expect(r.status).toBe(200);
    expect((await r.json()).reads).toMatchObject([{ caller: "token:0123abcd", label: "Sample client", tool: "email_search", args: { query: "invoice" }, first: true }]);
    expect((await (await fetch(url("/api/integration-reads/callers"), { headers: viewerAuth(home, port) })).json()).callers)
      .toEqual({ "token:0123abcd": { ts: "2026-10-07T12:00:00.000Z", integration: "email", name: "Gmail" } });
    expect((await fetch(url("/api/integration-reads?integration=nope&account=x"), { headers: viewerAuth(home, port) })).status).toBe(400);
    expect((await fetch(url(reads), { method: "POST", headers: { ...viewerAuth(home, port), "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  } finally { child.kill(); await child.exited; }
}, 30_000);
