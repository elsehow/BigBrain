/** Memory over every vault the user can read (lib/sharedMemory.ts): the shared
 * cache, its delta against the memory checkpoint, the due check a member with
 * an empty personal vault depends on, the run's context and citation gate, and
 * the refresh against a real shared door. Invented names throughout. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertionEntityId } from "../lib/assertionLog";
import { writeAtomic } from "../lib/fsx";
import { memoryDue, readMemoryStamp, writeMemoryStamp } from "../lib/memory";
import { runMemory } from "../lib/memoryRun";
import { addMember, initMemberStore, mintCredential } from "../lib/sharedMembers";
import { SharedVault } from "../lib/sharedVault";
import { makeSharedApiHandler } from "../lib/sharedVaultApi";
import { saveConnection } from "../lib/sharedConnections";
import {
  readSharedMemory, refreshSharedMemory, sharedMemoryDelta, unknownSharedCitations,
  type SharedMemory, type SharedMemoryAssertion, type SharedMemoryVault,
} from "../lib/sharedMemory";
import { fakeMemoryPi } from "./support/memoryPi";
import { gitVault, testManifest } from "./support/vault";

const project = { id: assertionEntityId("Example project"), label: "Example project" };
const claim = (n: number, over: Partial<SharedMemoryAssertion> = {}): SharedMemoryAssertion => ({
  id: `ast_${String(n).repeat(24)}`, text: `[[${project.id}|Example project]] has milestone ${n}.`, entities: [project],
  sources: [`ins_${String(n).repeat(24)}`], confidence: "direct", created_at: `2026-09-29T12:0${n}:00.000Z`,
  author: { kind: "agent", id: "alice" }, ...over,
});
const team = (over: Partial<SharedMemoryVault> = {}): SharedMemoryVault => ({
  id: "team", name: "Example team", head: 4, reachable: true, assertions: [claim(1), claim(2)],
  titles: { [`ins_${"1".repeat(24)}`]: "Kickoff notes", [`ins_${"2".repeat(24)}`]: "Budget thread" }, ...over,
});
const writeCache = (root: string, memory: SharedMemory) => { mkdirSync(join(root, ".state"), { recursive: true }); writeAtomic(join(root, ".state", "shared-memory.json"), JSON.stringify(memory)); };

describe("sharedMemoryDelta", () => {
  test("what no run observed is new; the checkpoint records the live ids", () => {
    const first = sharedMemoryDelta({ vaults: [team()] }, undefined);
    expect(first.fresh.map(f => f.assertion.id)).toEqual([claim(1).id, claim(2).id]);
    expect(first.checkpoint).toEqual({ team: { head: 4, assertions: [claim(1).id, claim(2).id] } });
    expect(first.recordChanged).toBe(false);
    const next = sharedMemoryDelta({ vaults: [team()] }, { team: { head: 3, assertions: [claim(1).id] } });
    expect(next.fresh.map(f => f.assertion.id)).toEqual([claim(2).id]);
  });
  test("a revoked claim an earlier run saw, or a vault no longer joined, is a record change", () => {
    const revoked = team({ assertions: [claim(1, { revoked: true }), claim(2)] });
    expect(sharedMemoryDelta({ vaults: [revoked] }, { team: { head: 3, assertions: [claim(1).id, claim(2).id] } }).recordChanged).toBe(true);
    expect(sharedMemoryDelta({ vaults: [] }, { team: { head: 3, assertions: [] } }).recordChanged).toBe(true);
  });
  test("a vault never read yet waits, carrying its earlier checkpoint", () => {
    const unread = team({ head: -1, reachable: false, assertions: [] });
    const delta = sharedMemoryDelta({ vaults: [unread] }, { team: { head: 2, assertions: [claim(1).id] } });
    expect(delta).toEqual({ fresh: [], checkpoint: { team: { head: 2, assertions: [claim(1).id] } }, recordChanged: false });
  });
});

describe("unknownSharedCitations", () => {
  test("resolves against the read view; a disconnected vault resolves nowhere; an unread one is not judged", () => {
    const memory = { vaults: [team(), team({ id: "unread", head: -1, assertions: [] })] };
    expect(unknownSharedCitations(memory, [["team", claim(1).id], ["unread", claim(9).id]])).toEqual([]);
    expect(unknownSharedCitations(memory, [["team", claim(9).id], ["gone", claim(1).id]]))
      .toEqual([`shared:gone:${claim(1).id}`, `shared:team:${claim(9).id}`]);
  });
});

const freshVault = () => gitVault({ prefix: "bb-shared-memory-", dirs: ["journal/memory", ".state"], files: { "prompts/memory.md": "MEMORY PASS TEMPLATE\n" }, commit: "seed" });
const manifest = (root: string) => testManifest(root, { memory: { adapter: "pi", provider: "anthropic", model: "claude-m", interval: "3h", intervalMs: 1 } });
const writeTree = (root: string, body: string) => () => { mkdirSync(join(root, "memory"), { recursive: true }); writeFileSync(join(root, "memory", "MEMORY.md"), `# Memory\n\n${body}\n`); };

describe("a member whose personal vault is empty", () => {
  test("is due a sweep once a joined vault holds claims, and memory folds them with shared citations", async () => {
    const root = freshVault();
    writeMemoryStamp(root, { nextRunAt: "2026-01-01T00:00:00.000Z" });
    expect(memoryDue(root).due).toBe(false);
    writeCache(root, { vaults: [team()] });
    const due = memoryDue(root);
    expect(due).toEqual({ due: true, reason: "scheduled sweep — 2 new shared-vault assertion(s)" });

    const captured: { prompt?: string } = {};
    const res = await runMemory({ root, manifest: manifest(root), loadPi: fakeMemoryPi(prompt => {
      captured.prompt = prompt;
      writeTree(root, `- Example project has two milestones. [[shared:team:${claim(1).id}]] [[shared:team:${claim(2).id}]]`)();
      return { result: "```report\nfolded the team's claims\n```\n" };
    }) });
    expect(res.error).toBeUndefined();
    expect(captured.prompt).toContain("## New shared-vault assertions since checkpoint (2)");
    expect(captured.prompt).toContain(`- shared:team:${claim(2).id} · direct · ${claim(2).created_at} · by agent alice`);
    expect(captured.prompt).toContain("sources: Budget thread");
    expect(readMemoryStamp(root).checkpoint?.shared).toEqual({ team: { head: 4, assertions: [claim(1).id, claim(2).id] } });
    expect(memoryDue(root).due).toBe(false);
  });

  test("a shared citation the vault does not hold reverts the run", async () => {
    const root = freshVault();
    writeCache(root, { vaults: [team()] });
    const res = await runMemory({ root, manifest: manifest(root), force: true, loadPi: fakeMemoryPi(() => {
      writeTree(root, `- Invented. [[shared:team:${claim(9).id}]]`)();
      return { result: "```report\nx\n```\n" };
    }) });
    expect(res.error).toContain(`unknown shared-vault citation(s): shared:team:${claim(9).id}`);
  });
});

describe("refreshSharedMemory", () => {
  test("pages a vault only when its feed moved, and keeps the last view when it cannot be reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-shared-refresh-")), shared = join(dir, "shared"), root = join(dir, "personal");
    mkdirSync(shared); mkdirSync(root);
    const members = join(dir, "members.json"), store = join(dir, "connections.json");
    initMemberStore(members, shared, { handle: "owner" });
    addMember(members, { handle: "alice", display: "Alice", permissions: ["read", "write"] });
    const alice = mintCredential(members, "alice", { name: "laptop" });
    const handler = makeSharedApiHandler({ root: shared, storePath: members, vault: new SharedVault(shared), log: () => {} });
    let paged = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => { if (req.method === "GET" && new URL(req.url).pathname === "/v1/assertions") paged++; return handler(req); } });
    const endpoint = `http://127.0.0.1:${server.port}`;
    const post = async (path: string, body: unknown) => (await fetch(endpoint + path, { method: "POST", headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ id: string }>;
    try {
      const c = await saveConnection(store, { name: "Example team", endpoint, token: alice.token });
      const e = await post("/v1/evidence", { title: "Kickoff notes", body: "The Example project kicked off." });
      const a = await post("/v1/assertions", { text: "[[Example project]] kicked off.", sources: [e.id] });
      const first = await refreshSharedMemory(root, store);
      expect(first.vaults).toHaveLength(1);
      expect(first.vaults[0]).toMatchObject({ id: c.id, reachable: true, titles: { [e.id]: "Kickoff notes" } });
      expect(first.vaults[0]!.assertions.map(x => x.id)).toEqual([a.id]);
      expect(paged).toBe(1);
      await refreshSharedMemory(root, store);
      expect(paged).toBe(1);
      const b = await post("/v1/assertions", { text: "[[Example project]] has a kickoff record.", sources: [e.id] });
      expect((await refreshSharedMemory(root, store)).vaults[0]!.assertions.map(x => x.id).sort()).toEqual([a.id, b.id].sort());
      expect(paged).toBe(2);
      server.stop(true);
      const offline = await refreshSharedMemory(root, store);
      expect(offline.vaults[0]).toMatchObject({ reachable: false });
      expect(offline.vaults[0]!.assertions).toHaveLength(2);
      expect(readSharedMemory(root)).toEqual(offline);
    } finally { server.stop(true); }
  });
});

describe("the memory pass's shared tools", () => {
  test("appear once a vault is joined; search answers with the citation to use", async () => {
    const { machineTools } = await import("../lib/run/machineTools");
    const root = freshVault();
    expect(machineTools(root, "memory").map(t => t.name)).not.toContain("shared_assertions");
    writeCache(root, { vaults: [team({ assertions: [claim(1), claim(2), claim(3, { revoked: true })] })] });
    const tools = machineTools(root, "memory");
    const search = tools.find(t => t.name === "shared_assertions")!;
    const found = await search.call({ query: "milestone 2" }) as { assertions: unknown[] };
    expect(found.assertions).toEqual([expect.objectContaining({ cite: `shared:team:${claim(2).id}`, author: "agent alice",
      sources: [{ path: `shared/team/ins_${"2".repeat(24)}.md`, title: "Budget thread" }] })]);
    expect(((await search.call({ entity: "example project" })) as { assertions: unknown[] }).assertions).toHaveLength(2);
    const read = tools.find(t => t.name === "read_shared_source")!;
    await expect(Promise.resolve().then(() => read.call({ path: "memory/MEMORY.md" }))).rejects.toThrow("path must be shared/<vault>/ins_<id>.md");
  });
});

describe("end to end", () => {
  test("a contributor's published claims make a member with an empty personal vault due a memory sweep", async () => {
    const { appendAssertionEvent, createAssertionEvent } = await import("../lib/assertionLog");
    const { appendSourceInsertionEvent, sourceInsertion } = await import("../lib/insertionLog");
    const { contributions, sendSources } = await import("../lib/sharedRules");
    const { publishAssertions } = await import("../lib/sharedAssertionPublish");
    const { readConnections } = await import("../lib/sharedConnections");
    const dir = mkdtempSync(join(tmpdir(), "bb-shared-e2e-")), shared = join(dir, "shared"), contributor = join(dir, "contributor");
    mkdirSync(shared); mkdirSync(contributor);
    const members = join(dir, "members.json"), contributorStore = join(dir, "contributor.json"), memberStore = join(dir, "member.json");
    initMemberStore(members, shared, { handle: "owner" });
    addMember(members, { handle: "alice", display: "Alice", permissions: ["read", "write"] });
    addMember(members, { handle: "bob", display: "Bob", permissions: ["read"] });
    const alice = mintCredential(members, "alice", { name: "laptop" }), bob = mintCredential(members, "bob", { name: "laptop" });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: makeSharedApiHandler({ root: shared, storePath: members, vault: new SharedVault(shared), log: () => {} }) });
    const endpoint = `http://127.0.0.1:${server.port}`;
    try {
      // Alice files a source at home, her gardener asserts from it, and she contributes the source.
      const kickoff = sourceInsertion({ id: "example-kickoff", title: "Kickoff notes", from: "Example", from_kind: "person", source: "web", date: "2026-09-29" }, "The Example project kicked off on Monday.");
      appendSourceInsertionEvent(contributor, kickoff);
      appendAssertionEvent(contributor, createAssertionEvent({ text: `[[${project.id}|Example project]] kicked off on Monday.`, entities: [project], sources: [kickoff.id],
        author: { kind: "model", id: "test", invocation_id: "run-1" }, confidence: "direct", created_at: "2026-09-29T12:00:00.000Z", produced_by: { procedure: "test", version: "v1" } }, new Map([[kickoff.id, kickoff]])));
      const a = await saveConnection(contributorStore, { name: "Example team", endpoint, token: alice.token });
      const aliceConnection = readConnections(contributorStore).find(c => c.id === a.id)!;
      await sendSources(contributorStore, aliceConnection, [kickoff]);
      expect((await publishAssertions(contributor, contributorStore, aliceConnection, await contributions(aliceConnection))).published).toBe(1);

      // Bob joined read-only and has filed nothing of his own.
      const member = freshVault();
      writeMemoryStamp(member, { nextRunAt: "2026-01-01T00:00:00.000Z" });
      await saveConnection(memberStore, { name: "Example team", endpoint, token: bob.token });
      await refreshSharedMemory(member, memberStore);
      expect(memoryDue(member)).toEqual({ due: true, reason: "scheduled sweep — 1 new shared-vault assertion(s)" });
    } finally { server.stop(true); }
  });
});
