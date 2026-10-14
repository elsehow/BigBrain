/** lensGrant.test.ts — a lens as a grant (#303), proved through the door.
 *
 * A synthetic vault (test/support/syntheticVault.ts, every name invented)
 * gets a lens: the owner's pins (one message of a thread, one of a pair of
 * copies, a spread of others), notes a scoring pass put in under the rule the
 * owner saw, and notes a later rule — a change nobody made — would add.
 * `bin/api.ts` serves it, and a real MCP client over HTTP reads through a
 * credential bound to that lens. The proof is mostly about what is MISSING:
 * every note outside the lens is refused by path and by id, never a search
 * hit, never cited in an entity's dossier or a thread, and memory is never
 * there at all. Briefings and relations are not served by the door to any
 * credential — the tool list below is exact. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeApiHandler } from "../lib/api";
import { listTokens } from "../lib/auth";
import { authenticateClient, ConnectedClients } from "../lib/connectedClients";
import { insertionEventRel, readSourceInsertionLog } from "../lib/insertionLog";
import { landScores, sayOnLens } from "../lib/lensRecord";
import { newLens, updateLens, writeLens, type Lens } from "../lib/lenses";
import { assertionEntityPath } from "../lib/assertionEntityView";
import { withSnapshot } from "../lib/vaultReadModel";
import { lensScopeOf } from "../lib/views/lensScope";
import { childEnv } from "./support/childEnv";
import { syntheticVault } from "./support/syntheticVault";

interface Row { insertion_id: string; source_id: string; title: string; occurred_at: string | null; received_at: string | null }
let root: string, store: string, clients: ConnectedClients, url: string, api: ReturnType<typeof Bun.spawn>;
let lens: Lens, token: string, client: Client;
let all: Row[], pinned: Set<string>, scoredIn: Set<string>, held: Set<string>, thread: { path: string; members: Row[] }, copies: Row[];

const pathOf = (r: Row) => insertionEventRel({ id: r.insertion_id, occurred_at: r.occurred_at ?? undefined, received_at: r.received_at ?? undefined } as never);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bb-lens-grant-"));
  syntheticVault(root, { sources: 150, seed: 3 });
  store = join(root, ".tokens");
  clients = new ConnectedClients(root, store);
  const rows = withSnapshot(root, ({ db }) => ({
    all: db.query("SELECT insertion_id, source_id, title, occurred_at, received_at FROM sources WHERE present = 1 ORDER BY insertion_id").all() as Row[],
    thread: db.query(`SELECT t.path, m.insertion_id FROM read_thread_members m JOIN read_thread_paths t ON t.thread_id = m.thread_id
      WHERE m.thread_id = (SELECT thread_id FROM read_thread_members GROUP BY thread_id HAVING count(*) >= 3 ORDER BY thread_id LIMIT 1)
      ORDER BY m.position`).all() as { path: string; insertion_id: string }[],
    copies: db.query(`SELECT insertion_id FROM source_copy_keys WHERE key = (SELECT key FROM source_copy_keys GROUP BY key HAVING count(*) = 2 ORDER BY key LIMIT 1)
      ORDER BY insertion_id`).all() as { insertion_id: string }[],
  }));
  all = rows.all;
  const byId = new Map(all.map((r) => [r.insertion_id, r]));
  thread = { path: rows.thread[0]!.path, members: rows.thread.map((m) => byId.get(m.insertion_id)!) };
  copies = rows.copies.map((c) => byId.get(c.insertion_id)!);
  const special = new Set([...thread.members, ...copies].map((r) => r.source_id));
  const rest = all.filter((r) => !special.has(r.source_id));
  // The owner pins one message of the thread, one of the copies, and every sixth other note.
  const pins = [thread.members[0]!, copies[0]!, ...rest.filter((_, i) => i % 6 === 0)];
  const ruleOne = rest.filter((_, i) => i % 6 === 1).slice(0, 8), ruleTwo = rest.filter((_, i) => i % 6 === 2).slice(0, 8);
  pinned = new Set(pins.map((r) => r.source_id));
  scoredIn = new Set(ruleOne.map((r) => r.source_id));
  held = new Set(ruleTwo.map((r) => r.source_id));

  lens = newLens({ name: "Apiary", text: "Notes about the apiary.", calibration: { identity: "rule-one", model: "model-a", threshold: 0.6 } });
  writeLens(root, lens);
  sayOnLens(root, lens, { pins: [...pinned], exclusions: [], ratings: [] }, { at: "2026-09-01T00:00:00.000Z" });
  const verdict = (r: Row, score: number) => ({ insertion_id: r.insertion_id, source_id: r.source_id, input: "synthetic", score }) as never;
  landScores(root, lens, "rule-one", "model-a", ruleOne.map((r) => verdict(r, 0.9)), { at: "2026-09-02T00:00:00.000Z" });
  // A model upgrade nobody asked for: the new rule would add ruleTwo.
  landScores(root, lens, "rule-two", "model-b", [...ruleOne, ...ruleTwo].map((r) => verdict(r, 0.9)), { at: "2026-09-03T00:00:00.000Z" });

  token = clients.token(clients.create({ name: "Apiary agent", kind: "claude-code", lens: lens.id }).id);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  url = `http://127.0.0.1:${port}/mcp`;
  api = Bun.spawn([process.execPath, resolve("bin/api.ts")], {
    env: childEnv({ BIGBRAIN_VAULT: root, BIGBRAIN_TOKENS: store, BIGBRAIN_API_PORT: String(port) }), stdout: "pipe", stderr: "pipe",
  });
  const reader = (api.stdout as ReadableStream<Uint8Array>).getReader();
  for (let seen = ""; !seen.includes("listening"); ) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`api exited: ${await new Response(api.stderr as ReadableStream).text()}`);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  void (api.stdout as ReadableStream).pipeTo(new WritableStream());
  client = new Client({ name: "lens-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
}, 60_000);
afterAll(async () => {
  await client?.close();
  api?.kill();
  rmSync(root, { recursive: true, force: true });
});

const served = () => new Set([...pinned, ...scoredIn]);
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: (r.content as { text: string }[])[0]!.text };
};
const read = (path: string, extra: Record<string, unknown> = {}) => call("read_note", { path, ...extra });
const search = async (query: string) => {
  const r = await call("search_vault", { query, n: 50 });
  expect(r.isError).toBe(false);
  return JSON.parse(r.text).hits as { path: string; snippet: string; assertions?: number }[];
};

test("the credential holds the lens instead of the vault, and only the door reads through it", async () => {
  const record = listTokens(store).find((t) => t.name === "Apiary agent")!;
  expect(record.scopes).toEqual([`lens:${lens.id}`, "inbox:write"]);
  expect(clients.list().find((c) => c.name === "Apiary agent")).toMatchObject({ lens: lens.id, vault: { read: false, contribute: true } });
  // Every whole-vault door refuses it on its own: the REST reads and the stdio server.
  const rest = makeApiHandler({ root, storePath: store, log: () => {} });
  for (const path of ["/v1/note?path=" + encodeURIComponent(pathOf(all[0]!)), "/v1/search?q=Orchard", "/v1/memory"])
    expect((await rest(new Request("http://127.0.0.1:4748" + path, { headers: { authorization: `Bearer ${token}` } }))).status).toBe(403);
  expect(() => authenticateClient(root, token, "vault:read", store)).toThrow();
  // A lens that does not exist cannot be granted.
  expect(() => clients.create({ name: "Nowhere", kind: "generic", lens: "lens_000000000000" })).toThrow("Choose a saved lens.");
});

test("its tools are the lens's reads and drop: no memory, no live integrations", async () => {
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["search_vault", "read_note", "drop"]);
  const memory = await call("load_memory", {});
  expect(memory.isError).toBe(true);
  expect(memory.text).not.toContain("#");
});

test("by path and by id: every served note reads, and no other note does", async () => {
  const want = served();
  expect(want.size).toBeGreaterThan(20);
  for (const r of all) {
    const got = await read(pathOf(r));
    if (want.has(r.source_id)) expect(got.isError).toBe(false);
    else {
      expect(got).toEqual({ isError: true, text: `${pathOf(r)} is not in this lens` });
      // An insertion id names its note in search; outside the lens it names nothing.
      expect(await search(r.insertion_id)).toEqual([]);
    }
  }
  // A path nothing is at answers exactly as one outside the lens does.
  expect(await read("log/insertions/2026-01/ins_000000000000000000000000.json")).toMatchObject({ isError: true });
  expect((await read(assertionEntityPath("ent_000000000000"))).text).toEndWith("is not in this lens");
});

test("additions nobody made are held until the owner looks", async () => {
  for (const id of held) expect((await read(pathOf(all.find((r) => r.source_id === id)!))).isError).toBe(true);
  // Looks OK: the owner adopts the new rule, and what it added is served.
  updateLens(root, lens.id, (l) => { l.calibration = { ...l.calibration, identity: "rule-two", model: "model-b" }; });
  for (const id of held) expect((await read(pathOf(all.find((r) => r.source_id === id)!))).isError).toBe(false);
  updateLens(root, lens.id, (l) => { l.calibration = { ...l.calibration, identity: "rule-one", model: "model-a" }; });
  for (const id of held) expect((await read(pathOf(all.find((r) => r.source_id === id)!))).isError).toBe(true);
});

test("search: every hit is served, entity counts are the lens's, and memory never answers", async () => {
  const scope = withSnapshot(root, (s) => lensScopeOf(s, lens));
  const servedPaths = new Set(all.filter((r) => scope.sources.has(r.source_id)).map(pathOf));
  const entities = withSnapshot(root, ({ db }) => db.query("SELECT id, label FROM entities").all() as { id: string; label: string }[]);
  const words = [...new Set([...all.map((r) => r.title), ...entities.map((e) => e.label)].flatMap((t) => t.split(/\W+/)).filter((w) => w.length > 3))];
  // A claim the lens does not hold is never a snippet (search shows claims with their links flattened).
  const flat = (t: string) => t.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/gu, "$1").replace(/\[\[([^\]]+)\]\]/gu, "$1");
  const claims = withSnapshot(root, ({ db }) => db.query("SELECT id, text FROM assertions").all() as { id: string; text: string }[]);
  const inside = new Set(claims.filter((c) => scope.assertions.has(c.id)).map((c) => flat(c.text)));
  const outside = [...new Set(claims.filter((c) => !scope.assertions.has(c.id)).map((c) => flat(c.text)))].filter((t) => !inside.has(t));
  let sources = 0, people = 0;
  for (const word of words.slice(0, 80)) {
    for (const hit of await search(word)) {
      expect(hit.path.startsWith("memory/")).toBe(false);
      for (const t of outside) expect(hit.snippet.includes(t)).toBe(false);
      if (hit.path.startsWith("projection/entities/")) {
        people++;
        // An entity is a hit only with claims the lens holds, and its count is of those.
        const page = await read(hit.path);
        expect(page.isError).toBe(false);
        expect(hit.assertions ?? 0).toBeLessThanOrEqual(JSON.parse(page.text).assertions_total);
      } else {
        sources++;
        expect(servedPaths.has(hit.path)).toBe(true);
      }
    }
  }
  expect(sources).toBeGreaterThan(0);
  expect(people).toBeGreaterThan(0);
  // The memory topics' own words find nothing of memory.
  for (const word of ["rota", "budget", "survey"]) for (const hit of await search(word)) expect(hit.path.startsWith("memory/")).toBe(false);
});

test("an entity page carries only claims every source of which is served, and cites only served notes", async () => {
  const scope = withSnapshot(root, (s) => lensScopeOf(s, lens));
  const rows = withSnapshot(root, ({ db }) => db.query(`SELECT e.entity_id, a.id, a.text FROM assertion_entities e JOIN assertions a ON a.id = e.assertion_id`).all() as { entity_id: string; id: string; text: string }[]);
  const byEntity = new Map<string, { id: string; text: string }[]>();
  for (const r of rows) byEntity.set(r.entity_id, [...(byEntity.get(r.entity_id) ?? []), r]);
  const servedPaths = new Set(all.filter((r) => scope.sources.has(r.source_id)).map(pathOf));
  let mixed = 0, outside = 0;
  for (const [entity, claims] of byEntity) {
    const inside = claims.filter((c) => scope.assertions.has(c.id)), out = claims.filter((c) => !scope.assertions.has(c.id));
    const page = await read(assertionEntityPath(entity));
    if (!inside.length) { outside++; expect(page.isError).toBe(true); continue; }
    if (page.isError) continue; // folded into another entity by an alias: read under its canonical id
    const note = JSON.parse(page.text);
    if (out.length) mixed++;
    for (const c of out) expect(note.markdown).not.toContain(c.text.slice(0, 60));
    for (const link of note.links as { path: string | null }[])
      if (link.path?.startsWith("log/insertions/")) expect(servedPaths.has(link.path)).toBe(true);
    for (const cited of note.markdown.matchAll(/\[\[(log\/insertions\/[^|\]]+)/g)) expect(servedPaths.has(cited[1])).toBe(true);
  }
  expect(mixed).toBeGreaterThan(0);
  expect(outside).toBeGreaterThan(0);
});

test("a thread comes with only its served messages, and copies name only served copies", async () => {
  const page = await read(thread.path);
  expect(page.isError).toBe(false);
  const note = JSON.parse(page.text);
  expect(note.markdown).toContain(pathOf(thread.members[0]!));
  for (const m of thread.members.slice(1)) expect(note.markdown).not.toContain(pathOf(m));
  expect(note.markdown).toContain("1 messages");
  const copy = JSON.parse((await read(pathOf(copies[0]!))).text);
  expect(copy.markdown).not.toContain(pathOf(copies[1]!));
  expect((await read(pathOf(copies[1]!))).isError).toBe(true);
});

test("memory, journals and sessions are never in a lens", async () => {
  for (const path of ["memory/MEMORY.md", "memory/rota-2.md", "memory/budget-0.md", "sessions/session_000000000000.json"])
    expect(await read(path)).toEqual({ isError: true, text: `${path} is not in this lens` });
});

test("a drop through the lens lands attributed, joins only if the rule has it in, and reads as agent voice", async () => {
  const before = readSourceInsertionLog(root).length;
  const dropped = await call("drop", { title: "Hive inspection", body: "Queen sighted in the second hive." });
  expect(dropped.isError).toBe(false);
  const landed = readSourceInsertionLog(root).at(-1)!;
  expect(readSourceInsertionLog(root)).toHaveLength(before + 1);
  expect(landed.envelope).toMatchObject({ from: "Apiary agent", from_kind: "agent", source: "mcp" });
  // Coming through the lens does not put it in.
  expect((await read(JSON.parse(dropped.text).path)).isError).toBe(true);
  // An ordinary note: scored out, it stays out; scored in by the rule the owner saw, it is in, fenced as an agent's words.
  const score = (s: number, at: string) => landScores(root, lens, "rule-one", "model-a", [{ insertion_id: landed.id, source_id: landed.source_id, input: "synthetic", score: s } as never], { at });
  score(0.2, "2026-09-04T00:00:00.000Z");
  expect((await read(JSON.parse(dropped.text).path)).isError).toBe(true);
  score(0.95, "2026-09-05T00:00:00.000Z");
  const note = await read(JSON.parse(dropped.text).path);
  expect(note.isError).toBe(false);
  expect(JSON.parse(note.text).provenance).toMatchObject({ trusted: false });
  expect(JSON.parse(note.text).markdown).toContain("<untrusted-data");
});

test("revoking the lens's connection closes it, and a deleted lens grants nothing", async () => {
  const other = clients.create({ name: "Second apiary agent", kind: "codex", lens: lens.id });
  const handler = makeApiHandler({ root, storePath: store, log: () => {} });
  const list = (t: string) => handler(new Request("http://127.0.0.1:4748/mcp", { method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  const t = clients.token(other.id);
  expect((await list(t)).status).toBe(200);
  clients.revoke(other.id);
  expect((await list(t)).status).toBe(401);
  const gone = newLens({ name: "Gone", text: "x" });
  writeLens(root, gone);
  const orphan = clients.token(clients.create({ name: "Orphan", kind: "generic", lens: gone.id }).id);
  rmSync(join(root, "lenses", `${gone.id}.json`));
  expect((await list(orphan)).status).toBe(403);
});
