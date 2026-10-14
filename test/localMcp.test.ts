/** localMcp.test.ts — the one door (#302), end to end: `bin/api.ts` serving
 * a scratch vault on 127.0.0.1, a real MCP client over HTTP (the SDK's
 * Streamable HTTP transport) presenting a Connected Clients credential. It
 * lists, reads and drops, and is refused without a credential, with the
 * wrong one, and the moment its connection is revoked. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mintToken } from "../lib/auth";
import { makeApiHandler } from "../lib/api";
import { ConnectedClients } from "../lib/connectedClients";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { childEnv } from "./support/childEnv";
import { insertionSeq, nativeVault, NATIVE_YAML } from "./support/vault";

const insertion = insertionSeq();
let root: string, store: string, clients: ConnectedClients, url: string, api: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  root = nativeVault({
    prefix: "bb-door-",
    insertions: [insertion({ title: "Lantern trial notes", body: "The Lantern trial moved to Thursday at the boathouse." })],
    files: { "vault.yaml": NATIVE_YAML, "memory/MEMORY.md": "# Memory index\nThe owner keeps bees.\n" },
  });
  store = join(root, ".tokens");
  clients = new ConnectedClients(root, store);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  url = `http://127.0.0.1:${port}/mcp`;
  api = Bun.spawn([process.execPath, resolve("bin/api.ts")], {
    env: childEnv({ BIGBRAIN_VAULT: root, BIGBRAIN_TOKENS: store, BIGBRAIN_API_PORT: String(port) }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (api.stdout as ReadableStream<Uint8Array>).getReader();
  for (let seen = ""; !seen.includes("listening"); ) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`api exited: ${await new Response(api.stderr as ReadableStream).text()}`);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  void (api.stdout as ReadableStream).pipeTo(new WritableStream());
});
afterAll(() => {
  api?.kill();
  rmSync(root, { recursive: true, force: true });
});

async function connect(token?: string): Promise<Client> {
  const client = new Client({ name: "Spoofed name", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}));
  return client;
}
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
const post = (headers: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

test("a connected agent lists the stdio server's tools, reads, and drops attributed to its connection", async () => {
  const setup = clients.create({ name: "Door Claude", kind: "claude-code" });
  expect(setup.url).toBe(url.replace(/:\d+\//, ":4748/")); // the test's port is its own; the default is 4748
  const client = await connect(clients.token(setup.id));
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(["load_memory", "search_vault", "read_note", "drop"]);
    expect(tools.find((t) => t.name === "drop")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(client.getInstructions()).toContain("load_memory");

    expect(textOf(await client.callTool({ name: "load_memory", arguments: {} }))).toContain("The owner keeps bees.");
    const search = JSON.parse(textOf(await client.callTool({ name: "search_vault", arguments: { query: "Lantern" } })));
    expect(search.hits.map((h: { title: string }) => h.title)).toContain("Lantern trial notes");
    const note = JSON.parse(textOf(await client.callTool({ name: "read_note", arguments: { path: search.hits[0].path } })));
    expect(JSON.stringify(note)).toContain("boathouse");

    const before = readSourceInsertionLog(root).length;
    const dropped = await client.callTool({ name: "drop", arguments: { title: "Bee count", body: "Twelve hives in October." } });
    expect(dropped.isError).not.toBe(true);
    const landed = readSourceInsertionLog(root);
    expect(landed).toHaveLength(before + 1);
    // The credential names the author, never the client's own handshake.
    expect(landed.at(-1)?.envelope).toMatchObject({ from: "Door Claude", from_kind: "agent", source: "mcp" });
    expect(clients.list().find((c) => c.id === setup.id)?.lastUsed).toBeTruthy();

    // Nothing edits or deletes: those are not tools, and an unknown name is refused.
    expect((await client.callTool({ name: "submit", arguments: { items: [] } })).isError).toBe(true);

    // Revoking closes the door at the next request.
    clients.revoke(setup.id);
    await expect(client.callTool({ name: "load_memory", arguments: {} })).rejects.toThrow();
    expect(readSourceInsertionLog(root)).toHaveLength(before + 1);
  } finally {
    await client.close();
  }
});

test("no credential, a stranger's, or the wrong scope is refused", async () => {
  await expect(connect()).rejects.toThrow();
  await expect(connect("bb_00000000_notarealsecret")).rejects.toThrow();
  expect((await post({})).status).toBe(401);
  expect((await post({ authorization: "Bearer bb_00000000_notarealsecret" })).status).toBe(401);

  // A paired browser extension can drop over /v1/drop, but it is no agent and cannot read.
  const paired = mintToken(store, root, "browser", ["inbox:write"], { via: "pair" });
  expect((await post({ authorization: `Bearer ${paired.token}` })).status).toBe(403);
  // An operator's reading token is not on the consent surface, so not let in either.
  const operator = mintToken(store, root, "script", ["vault:read", "inbox:write"]);
  expect((await post({ authorization: `Bearer ${operator.token}` })).status).toBe(403);
  // A connection that can read but not write: no drop in the list, and none by name.
  const reader = mintToken(store, root, "Reader", ["vault:read"], { kind: "agent", via: "client" });
  const client = await connect(reader.token);
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("drop");
    await expect(client.callTool({ name: "drop", arguments: { title: "x", body: "y" } })).rejects.toThrow();
  } finally {
    await client.close();
  }
  // A browser page cannot use it, credential or not.
  const live = clients.create({ name: "Door Codex", kind: "codex" });
  expect((await post({ authorization: `Bearer ${clients.token(live.id)}`, origin: "https://pages.example" })).status).toBe(403);
  expect((await post({ authorization: `Bearer ${clients.token(live.id)}` })).status).toBe(200);
  // Nor anything through a proxy or under a rebound name: the Host is not this machine's.
  for (const host of ["bigbrain.example", "rebind.example:4748", "127.0.0.1.example"])
    expect((await post({ authorization: `Bearer ${clients.token(live.id)}`, host })).status).toBe(403);
  // Stateless: there is no stream to open.
  expect((await fetch(url, { headers: { authorization: `Bearer ${clients.token(live.id)}` } })).status).toBe(405);
});

test("a lapsed connection is served, every tool answering where to renew it, and nothing lands", async () => {
  const setup = clients.create({ name: "Lapsed Codex", kind: "codex" }), token = clients.token(setup.id);
  const later = new Date(Date.now() + 31 * 86_400_000);
  const handler = makeApiHandler({ root, storePath: store, now: () => later, log: () => {} });
  const call = (name: string, args: Record<string, unknown>) => handler(new Request("http://127.0.0.1:4748/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })).then((r) => r.json());
  const before = readSourceInsertionLog(root).length;
  for (const [name, args] of [["load_memory", {}], ["drop", { title: "No", body: "Should not land." }]] as const) {
    const { result } = await call(name, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Renew it in BigBrain → Settings → Connected agents.");
  }
  expect(readSourceInsertionLog(root)).toHaveLength(before);
  // A lapsed reader is not offered a drop it never had.
  const reader = mintToken(store, root, "Lapsed reader", ["vault:read"], { kind: "agent", via: "client" });
  const listed = await handler(new Request("http://127.0.0.1:4748/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${reader.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })).then((r) => r.json());
  expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(["load_memory", "search_vault", "read_note"]);
});
