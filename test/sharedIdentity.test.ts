/** Identity on a shared vault (step 7 of docs/plans/2026-10-11-field-of-assertions.md):
 * the server holds copy and is-source identity that cites its evidence;
 * publishing sends yours while every landing it cites is shared there; and a
 * reader's field applies it. A real door on a loopback port; names invented. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentityAssertion, sameAs, assertionEntityId } from "../lib/assertionLog";
import { appendAndProjectAssertion, projectSourceInsertion } from "../lib/assertionProjection";
import { appendSourceInsertionEvent, sourceInsertion, type SourceInsertion } from "../lib/insertionLog";
import { addMember, initMemberStore, mintCredential, verifyCredential } from "../lib/sharedMembers";
import { SharedVault, SharedVaultError } from "../lib/sharedVault";
import { makeSharedApiHandler } from "../lib/sharedVaultApi";
import { readConnections, saveConnection } from "../lib/sharedConnections";
import { contributions, sendSources } from "../lib/sharedRules";
import { publishAssertions } from "../lib/sharedAssertionPublish";
import { followServers, readServer } from "../lib/serverStore";
import { sharedProjection } from "../lib/sharedWorkspace";

const said = { author: { kind: "user", id: "owner" } as const, created_at: "2026-09-29T12:00:00.000Z", produced_by: { procedure: "test", version: "1" } };

function server() {
  const dir = mkdtempSync(join(tmpdir(), "bb-shared-identity-")), shared = join(dir, "shared"), members = join(dir, "members.json");
  mkdirSync(shared);
  initMemberStore(members, shared, { handle: "owner" });
  addMember(members, { handle: "alice", display: "Alice", permissions: ["read", "write"] });
  const alice = mintCredential(members, "alice", { name: "laptop" });
  const vault = new SharedVault(shared);
  const actor = () => { const v = verifyCredential(members, alice.token); if (!v.ok) throw Error("auth"); return v.actor; };
  return { dir, shared, members, vault, alice, actor };
}

test("a server holds copy and is-source identity that cites its evidence, and nothing that cites none", () => {
  const s = server();
  const a = s.vault.dropEvidence(s.actor(), { title: "Planting order", body: "The spring order, as agreed." }).insertion;
  const b = s.vault.dropEvidence(s.actor(), { title: "Planting order (copy)", body: "The spring order, as agreed. Resent." }).insertion;
  const copy = s.vault.identify(s.actor(), { identity: { says: "copy" }, sources: [a.id, b.id] });
  expect(copy.deduped).toBe(false);
  expect(s.vault.identify(s.actor(), { identity: { says: "copy" }, sources: [a.id, b.id] }).deduped).toBe(true);
  expect(() => s.vault.identify(s.actor(), { identity: { says: "copy" }, sources: [a.id, b.id], score: 0.9 })).toThrow("unknown identity field");
  const bound = s.vault.identify(s.actor(), { identity: { says: "is-source", entity: { label: "Spring Order" } }, sources: [a.id] });
  expect(s.vault.listIdentities().items.map((e) => e.identity.says).sort()).toEqual(["copy", "is-source"]);
  expect(() => s.vault.identify(s.actor(), { identity: { says: "same" }, sources: [] })).toThrow(SharedVaultError);
  expect(() => s.vault.identify(s.actor(), { identity: { says: "copy" }, sources: [a.id, `ins_${"f".repeat(24)}`] })).toThrow("no evidence");
  s.vault.retract(s.actor(), bound.identity.id, { reason: "not that entity" });
  expect(s.vault.listIdentities().items.map((e) => e.identity.says)).toEqual(["copy"]);
  // a reader's field draws the copies as one work
  const view = sharedProjection([a, b], [], s.vault.listIdentities().items);
  const drawn = view.graph.nodes.filter((n) => n.group === "source");
  expect(drawn).toHaveLength(1); // the earlier landing, ties by id, standing for both
  expect(drawn[0]!.memberPaths).toHaveLength(1);
});

test("publishing sends your copy and is-source identity while its landings are shared there, never an alias; a fresh reader applies it", async () => {
  const s = server(), personal = join(s.dir, "personal"), store = join(s.dir, "connections.json");
  mkdirSync(personal);
  const land = (id: string, title: string, body: string) => {
    const x = sourceInsertion({ id, title, from: "Example", from_kind: "person", source: "web", date: "2026-09-29" }, body);
    appendSourceInsertionEvent(personal, x, { wake: false }); projectSourceInsertion(personal, x); return x;
  };
  const one = land("orchard-1", "Orchard plan", "The orchard plan, first draft.");
  const two = land("orchard-2", "Orchard plan, again", "The orchard plan, first draft, captured twice.");
  const byId = new Map<string, SourceInsertion>([one, two].map((x) => [x.id, x]));
  const plan = { id: assertionEntityId("Orchard Plan"), label: "Orchard Plan" };
  appendAndProjectAssertion(personal, createIdentityAssertion({ identity: { says: "copy" }, sources: [one.id, two.id], ...said }, byId));
  appendAndProjectAssertion(personal, createIdentityAssertion({ identity: { says: "is-source", entity: plan }, sources: [one.id], ...said }, byId));
  appendAndProjectAssertion(personal, createIdentityAssertion({ identity: sameAs("Plan", plan), ...said }));
  const door = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: makeSharedApiHandler({ root: s.shared, storePath: s.members, vault: s.vault, log: () => {} }) });
  const old = process.env.BIGBRAIN_SHARED_CONNECTIONS; process.env.BIGBRAIN_SHARED_CONNECTIONS = store;
  try {
    const c = await saveConnection(store, { name: "Garden club", endpoint: `http://127.0.0.1:${door.port}`, token: s.alice.token });
    const connection = () => readConnections(store).find((x) => x.id === c.id)!;
    // only one landing shared: neither the pair nor anything citing the other goes
    await sendSources(store, connection(), [one]);
    expect(await publishAssertions(personal, store, connection(), await contributions(connection()))).toEqual({ published: 1, retracted: 0 });
    expect(s.vault.listIdentities().items.map((e) => e.identity.says)).toEqual(["is-source"]);
    await sendSources(store, connection(), [two]);
    expect(await publishAssertions(personal, store, connection(), await contributions(connection()))).toEqual({ published: 1, retracted: 0 });
    expect(s.vault.listIdentities().items.map((e) => e.identity.says).sort()).toEqual(["copy", "is-source"]);
    // a fresh reader: the follower's copy of the server, drawn
    await followServers(store);
    const held = readServer(store, c.id).snapshot!;
    expect(held.identities).toHaveLength(2);
    const field = sharedProjection(held.evidence, held.assertions, held.identities);
    const sources = field.graph.nodes.filter((n) => n.group === "source");
    expect(sources).toHaveLength(1);
    expect(sources[0]!.memberPaths).toHaveLength(1);
  } finally {
    door.stop(true);
    if (old === undefined) delete process.env.BIGBRAIN_SHARED_CONNECTIONS; else process.env.BIGBRAIN_SHARED_CONNECTIONS = old;
  }
});
