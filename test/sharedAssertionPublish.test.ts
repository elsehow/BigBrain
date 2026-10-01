/** Publishing a contributor's claims to a shared vault (lib/sharedAssertionPublish.ts):
 * a real shared door on a loopback port, contributions made through the same
 * sendSources the inclusion controller uses, and invented names throughout. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { appendRevocationEvent, createRevocationEvent } from "../lib/revocationLog";
import { appendSourceInsertionEvent, sourceInsertion, type SourceInsertion } from "../lib/insertionLog";
import { addMember, initMemberStore, mintCredential, verifyCredential } from "../lib/sharedMembers";
import { SharedVault } from "../lib/sharedVault";
import { makeSharedApiHandler } from "../lib/sharedVaultApi";
import { readConnections, saveConnection } from "../lib/sharedConnections";
import { contributions, sendSources } from "../lib/sharedRules";
import { publishAssertions, publishableText, publishedPath } from "../lib/sharedAssertionPublish";

const briar = { id: assertionEntityId("Briar Calder"), label: "Briar Calder" };
const parent = { id: assertionEntityId("Jane Example"), label: "Jane Example" };

describe("publishableText", () => {
  test("keeps a label the sources say, and drops one the personal vault resolved on its own", () => {
    const a = { text: `[[${briar.id}|Briar]] approved what [[${parent.id}|mom]] proposed.`, entities: [briar, parent] };
    expect(publishableText(a, "Briar Calder approved the plan mom proposed.")).toBe("[[Briar Calder|Briar]] approved what mom proposed.");
    expect(publishableText({ text: `[[${briar.id}|Briar Calder]] owns the plan.`, entities: [briar] }, "briar calder owns it")).toBe("[[Briar Calder]] owns the plan.");
  });
  test("matches whole words only, and refuses what the door would refuse", () => {
    const al = { id: assertionEntityId("Al"), label: "Al" };
    expect(publishableText({ text: `[[${al.id}|Al]] signed the lease.`, entities: [al] }, "Also signed.")).toBe("Al signed the lease.");
    expect(publishableText({ text: "Too short", entities: [] }, "")).toBeNull();
  });
});

function fixture(opts: { agentRoute?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bb-publish-")), personal = join(dir, "personal"), shared = join(dir, "shared");
  for (const root of [personal, shared]) mkdirSync(root);
  const members = join(dir, "members.json"), store = join(dir, "connections.json");
  const source = (id: string, title: string, body: string) => {
    const s = sourceInsertion({ id, title, from: "Example", from_kind: "person", source: "web", date: "2026-09-29" }, body);
    appendSourceInsertionEvent(personal, s); return s;
  };
  const kickoff = source("example-kickoff", "Kickoff notes", "Briar Calder owns the kickoff plan.");
  const budget = source("example-budget", "Budget thread", "mom approved the budget on Tuesday.");
  const diary = source("example-diary", "Private diary", "A private note that is never shared.");
  const byId = new Map<string, SourceInsertion>([kickoff, budget, diary].map(s => [s.id, s]));
  const assert = (text: string, entities: (typeof briar)[], sources: string[], minute: number) => appendAssertionEvent(personal, createAssertionEvent({
    text, entities, sources, author: { kind: "model", id: "test", invocation_id: `run-${minute}` }, confidence: "direct",
    created_at: `2026-09-29T12:0${minute}:00.000Z`, produced_by: { procedure: "test", version: "v1" },
  }, byId)).event;
  const owns = assert(`[[${briar.id}|Briar Calder]] owns the kickoff plan.`, [briar], [kickoff.id], 1);
  const approved = assert(`[[${parent.id}|mom]] approved the budget on Tuesday.`, [parent], [budget.id], 2);
  assert(`[[${briar.id}|Briar Calder]] wrote about the kickoff privately.`, [briar], [kickoff.id, diary.id], 3);

  const owner = initMemberStore(members, shared, { handle: "owner" });
  addMember(members, { handle: "alice", display: "Alice", permissions: ["read", "write"] });
  const alice = mintCredential(members, "alice", { name: "laptop" });
  const vault = new SharedVault(shared);
  const handler = makeSharedApiHandler({ root: shared, storePath: members, vault, log: () => {} });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req =>
    opts.agentRoute === false && new URL(req.url).pathname === "/v1/credentials/agent" ? new Response("{}", { status: 404 }) : handler(req) });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const live = async () => {
    const r = await fetch(`${endpoint}/v1/assertions`, { headers: { Authorization: `Bearer ${owner.token}` } });
    return ((await r.json()) as { items: { assertion: { text: string; author: unknown } }[] }).items.map(i => i.assertion);
  };
  const actor = () => { const v = verifyCredential(members, alice.token); if (!v.ok) throw Error("auth"); return v.actor; };
  return { personal, store, server, endpoint, vault, alice, kickoff, budget, owns, approved, live, actor };
}

describe("publishAssertions", () => {
  test("publishes what every cited source supports, as the member's agent, then retracts on withdrawal and revocation", async () => {
    const f = fixture();
    try {
      const c = await saveConnection(f.store, { name: "Example", endpoint: f.endpoint, token: f.alice.token });
      const connection = readConnections(f.store).find(x => x.id === c.id)!;
      await sendSources(f.store, connection, [f.kickoff, f.budget]);

      expect(await publishAssertions(f.personal, f.store, connection, await contributions(connection))).toEqual({ published: 2, retracted: 0 });
      const shared = await f.live();
      expect(shared.map(a => a.text).sort()).toEqual([`[[${briar.id}|Briar Calder]] owns the kickoff plan.`, "mom approved the budget on Tuesday."]);
      expect(shared.every(a => JSON.stringify(a.author) === JSON.stringify({ kind: "agent", id: "alice" }))).toBe(true);
      const minted = readConnections(f.store).find(x => x.id === c.id)!;
      expect(minted.agentToken).toMatch(/^sv_/);
      // Settled: a second pass writes nothing.
      expect(await publishAssertions(f.personal, f.store, minted, await contributions(minted))).toEqual({ published: 0, retracted: 0 });

      const budgetContribution = f.vault.contributions(f.actor()).find(x => x.title === "Budget thread")!;
      f.vault.transitionContribution(f.actor(), budgetContribution.id, "withdrawn", { request_id: "withdraw-budget", version: budgetContribution.version });
      expect(await publishAssertions(f.personal, f.store, minted, await contributions(minted))).toEqual({ published: 0, retracted: 1 });
      expect((await f.live()).map(a => a.text)).toEqual([`[[${briar.id}|Briar Calder]] owns the kickoff plan.`]);

      appendRevocationEvent(f.personal, createRevocationEvent({ assertion_id: f.owns.id, reason: "wrong", author: { kind: "model", id: "test", invocation_id: "run-revoke" },
        created_at: "2026-09-29T13:00:00.000Z", produced_by: { procedure: "test", version: "v1" } }));
      expect(await publishAssertions(f.personal, f.store, minted, await contributions(minted))).toEqual({ published: 0, retracted: 1 });
      expect(await f.live()).toEqual([]);
      const receipts = JSON.parse(readFileSync(publishedPath(f.store), "utf8"));
      expect(Object.values(receipts).map((r: any) => r.status)).toEqual(["retracted", "retracted"]);
    } finally { f.server.stop(true); }
  });

  test("stays within its write budget and resumes on the next pass", async () => {
    const f = fixture();
    try {
      const c = await saveConnection(f.store, { name: "Example", endpoint: f.endpoint, token: f.alice.token });
      const connection = readConnections(f.store).find(x => x.id === c.id)!;
      await sendSources(f.store, connection, [f.kickoff, f.budget]);
      expect(await publishAssertions(f.personal, f.store, connection, await contributions(connection), 1)).toEqual({ published: 1, retracted: 0 });
      const minted = readConnections(f.store).find(x => x.id === c.id)!;
      expect(await publishAssertions(f.personal, f.store, minted, await contributions(minted), 1)).toEqual({ published: 1, retracted: 0 });
      expect(await f.live()).toHaveLength(2);
    } finally { f.server.stop(true); }
  });

  test("an older door that cannot mint an agent leaves the vault unpublished rather than speaking as the member", async () => {
    const f = fixture({ agentRoute: false });
    try {
      const c = await saveConnection(f.store, { name: "Example", endpoint: f.endpoint, token: f.alice.token });
      const connection = readConnections(f.store).find(x => x.id === c.id)!;
      await sendSources(f.store, connection, [f.kickoff, f.budget]);
      expect(await publishAssertions(f.personal, f.store, connection, await contributions(connection))).toEqual({ published: 0, retracted: 0 });
      expect(await f.live()).toEqual([]);
    } finally { f.server.stop(true); }
  });
});
