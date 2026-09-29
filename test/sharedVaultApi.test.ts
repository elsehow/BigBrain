/**
 * The shared-vault door, handler-level: `makeSharedApiHandler` called with
 * `new Request(...)` — no socket. The same handler bin/shared.ts serves;
 * test/sharedVaultServer.test.ts drives the real entrypoint.
 *
 * Every name here is invented (owner / alice / bob / carol); every vault is a
 * scratch directory.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAssertionLog } from "../lib/assertionLog";
import { readRevocationLog } from "../lib/revocationLog";
import { addMember, initMemberStore, listCredentials, mintCredential, revokeCredential, revokeMember, setMemberPermissions, usagePath } from "../lib/sharedMembers";
import { SHARED_FEED_DIR, SharedVault } from "../lib/sharedVault";
import { makeSharedApiHandler, SHARED_ROUTES } from "../lib/sharedVaultApi";

interface World {
  root: string;
  store: string;
  handler: (req: Request) => Promise<Response>;
  owner: string;
  alice: string;
  bob: string;
  /** carol: read-only member */
  carol: string;
  /** alice's agent credential, read+write */
  aliceAgent: string;
  /** alice's read-only credential */
  aliceReadOnly: string;
  bobCredentialId: string;
}

function world(opts: { now?: () => Date } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "bb-shared-api-"));
  const root = join(dir, "vault");
  mkdirSync(root);
  const store = join(dir, "members.json");
  const o = initMemberStore(store, root, { handle: "owner", display: "The Owner" });
  addMember(store, { handle: "alice", display: "Alice", permissions: ["read", "write"] });
  addMember(store, { handle: "bob", display: "Bob", permissions: ["read", "write"] });
  addMember(store, { handle: "carol", display: "Carol", permissions: ["read"] });
  const alice = mintCredential(store, "alice", { name: "laptop" });
  const aliceAgent = mintCredential(store, "alice", { name: "assistant", kind: "agent" });
  const aliceReadOnly = mintCredential(store, "alice", { name: "viewer", scopes: ["read"] });
  const bob = mintCredential(store, "bob", { name: "phone" });
  const carol = mintCredential(store, "carol", { name: "tablet" });
  const handler = makeSharedApiHandler({ root, storePath: store, log: () => {}, ...(opts.now ? { now: opts.now } : {}) });
  return {
    root, store, handler,
    owner: o.token, alice: alice.token, bob: bob.token, carol: carol.token,
    aliceAgent: aliceAgent.token, aliceReadOnly: aliceReadOnly.token, bobCredentialId: bob.credential.id,
  };
}

const call = (
  handler: World["handler"],
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  handler(
    new Request(`http://shared.test${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    })
  );

const asJson = async (res: Response): Promise<any> => res.json();

async function dropEvidence(w: World, token: string, title: string, body: string, origin?: Record<string, unknown>) {
  const res = await call(w.handler, "POST", "/v1/evidence", token, { title, body, ...(origin ? { origin } : {}) });
  const j = await asJson(res);
  if (res.status >= 300) throw new Error(`evidence ${res.status}: ${j.error}`);
  return j as { id: string; source_id: string; deduped: boolean; seq: number | null };
}

async function assertClaim(w: World, token: string, text: string, sources: string[]) {
  const res = await call(w.handler, "POST", "/v1/assertions", token, { text, sources });
  const j = await asJson(res);
  if (res.status >= 300) throw new Error(`assert ${res.status}: ${j.error}`);
  return j as { id: string; deduped: boolean; seq: number | null };
}

describe("shared vault — the smoke scenario, end to end at the handler", () => {
  test("owner/alice/bob: provision, drop evidence, assert with citations, read, search, correct, revoke bob", async () => {
    const w = world();

    // whoami: the actor is what the credential says, nothing else
    const who = await asJson(await call(w.handler, "GET", "/v1/whoami", w.alice));
    expect(who).toMatchObject({ handle: "alice", role: "member", kind: "person", permissions: ["read", "write"], credential: { name: "laptop" } });
    expect(await asJson(await call(w.handler, "GET", "/v1/whoami", w.owner))).toMatchObject({ handle: "owner", role: "owner" });

    // Alice drops her own note; Bob drops a forwarded message from someone
    // outside the vault, naming its original author and stable id.
    const e1 = await dropEvidence(w, w.alice, "Atlas kickoff notes", "The Atlas experiment should test sparse probes first, said Ada.");
    const e2 = await dropEvidence(w, w.bob, "Fwd: Atlas budget", "Grace wrote: the Atlas budget is capped at 40 units this quarter.", {
      id: "msg-2026-0001@example.test", author: "grace", kind: "email", date: "2026-03-04",
    });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);

    // Read back: submitter vs origin author vs origin identity, all distinct
    const ev1 = await asJson(await call(w.handler, "GET", `/v1/evidence/${e1.id}`, w.bob));
    expect(ev1.author).toEqual({ kind: "user", id: "alice" });
    expect(ev1.envelope.submitted_by).toBe("alice");
    expect(ev1.envelope.origin).toMatchObject({ author: "alice", author_verified: true });
    expect(ev1.source_id.startsWith("shared:")).toBe(true);
    const ev2 = await asJson(await call(w.handler, "GET", `/v1/evidence/${e2.id}`, w.alice));
    expect(ev2.author).toEqual({ kind: "user", id: "bob" });
    expect(ev2.envelope.submitted_by).toBe("bob");
    expect(ev2.envelope.submitted_via).toBe(w.bobCredentialId);
    expect(ev2.source_id).toBe("origin:msg-2026-0001@example.test");
    expect(ev2.envelope.origin).toMatchObject({ id: "origin:msg-2026-0001@example.test", author: "grace", author_verified: false, kind: "email", date: "2026-03-04" });
    expect(ev2.occurred_at).toBe("2026-03-04");

    // Assertions with valid citations; entity links canonicalize server-side
    const a1 = await assertClaim(w, w.alice, "[[Ada]] wants [[Atlas]] to test sparse probes first.", [e1.id]);
    const a2 = await assertClaim(w, w.bob, "[[Atlas]] has a budget cap of 40 units this quarter.", [e2.id, e1.id]);
    expect(a1.seq).toBe(3);
    expect(a2.seq).toBe(4);
    const v1 = await asJson(await call(w.handler, "GET", `/v1/assertions/${a1.id}`, w.carol));
    expect(v1.assertion.author).toEqual({ kind: "user", id: "alice" });
    expect(v1.assertion.text).toMatch(/^\[\[ent_[a-f0-9]{20}\|Ada\]\] wants \[\[ent_[a-f0-9]{20}\|Atlas\]\] to test sparse probes first\.$/u);
    expect(v1.assertion.entities).toHaveLength(2);
    expect(v1.assertion.sources).toEqual([{ insertion_id: e1.id, source_id: ev1.source_id }]);
    expect(v1.revocation).toBeNull();
    expect(v1.resolved_id).toBe(a1.id);

    // Search sees both kinds, from a read-only member
    const hits = (await asJson(await call(w.handler, "GET", "/v1/search?q=atlas%20budget", w.carol))).hits;
    expect(hits.map((h: any) => h.kind).sort()).toEqual(["assertion", "evidence"]);
    expect(hits.find((h: any) => h.kind === "assertion").id).toBe(a2.id);

    // Alice corrects her own assertion: append-only, both events attributed to her
    const corr = await asJson(
      await call(w.handler, "POST", `/v1/assertions/${a1.id}/correct`, w.alice, {
        text: "[[Ada]] wants [[Atlas]] to test sparse probes before dense ones.", sources: [e1.id], reason: "more precise",
      })
    );
    expect(corr).toMatchObject({ supersedes: a1.id, deduped: false, author: { kind: "user", id: "alice" } });
    expect(corr.seq).toBe(6); // assertion = 5, revocation = 6
    const old = await asJson(await call(w.handler, "GET", `/v1/assertions/${a1.id}`, w.bob));
    expect(old.revocation).toMatchObject({ assertion_id: a1.id, superseded_by: corr.id, reason: "more precise", author: { kind: "user", id: "alice" }, produced_by: { procedure: "shared-vault/correction" } });
    expect(old.resolved_id).toBe(corr.id);
    expect(old.assertion.text).toContain("sparse probes first"); // the original is untouched
    const fresh = await asJson(await call(w.handler, "GET", `/v1/assertions/${corr.id}`, w.bob));
    expect(fresh.assertion.supersedes).toBe(a1.id);
    expect(fresh.revocation).toBeNull();
    // the live record no longer includes the old claim; the full one still does
    expect(readAssertionLog(w.root).map((a) => a.id).sort()).toEqual([a2.id, corr.id].sort());
    expect(readAssertionLog(w.root, { includeRevoked: true })).toHaveLength(3);
    expect((await asJson(await call(w.handler, "GET", "/v1/search?q=sparse%20probes%20first", w.carol))).hits.filter((h: any) => h.kind === "assertion")).toHaveLength(0);

    // The feed is the total order, resumable
    const feed = await asJson(await call(w.handler, "GET", "/v1/feed?after=0&limit=100", w.carol));
    expect(feed.head).toBe(6);
    expect(feed.entries.map((e: any) => [e.seq, e.kind, e.actor.handle])).toEqual([
      [1, "evidence", "alice"], [2, "evidence", "bob"], [3, "assertion", "alice"], [4, "assertion", "bob"], [5, "assertion", "alice"], [6, "revocation", "alice"],
    ]);
    expect(feed.entries[5]).toMatchObject({ mode: "correction", assertion_id: a1.id, superseded_by: corr.id });
    expect(feed.entries[1].actor).toMatchObject({ handle: "bob", credential_id: w.bobCredentialId, kind: "person" });

    // Revoke Bob: every subsequent request from him is refused, his record stands
    revokeMember(w.store, "bob");
    expect((await call(w.handler, "GET", "/v1/whoami", w.bob)).status).toBe(401);
    expect((await call(w.handler, "GET", "/v1/feed", w.bob)).status).toBe(401);
    expect((await call(w.handler, "POST", "/v1/evidence", w.bob, { title: "x", body: "y" })).status).toBe(401);
    expect((await asJson(await call(w.handler, "GET", `/v1/assertions/${a2.id}`, w.alice))).assertion.author.id).toBe("bob");

    // Owner moderation: separately attributed, its own procedure
    const mod = await asJson(await call(w.handler, "POST", "/v1/moderation", w.owner, { assertion_id: a2.id, reason: "bob's source was a forward we cannot verify" }));
    expect(mod).toMatchObject({ assertion_id: a2.id, author: { kind: "user", id: "owner" }, procedure: "shared-vault/moderation", seq: 7 });
    const moderated = await asJson(await call(w.handler, "GET", `/v1/assertions/${a2.id}`, w.alice));
    expect(moderated.revocation).toMatchObject({ author: { id: "owner" }, produced_by: { procedure: "shared-vault/moderation" } });
    expect(moderated.revocation.superseded_by).toBeUndefined();
    expect(moderated.resolved_id).toBe(a2.id);
    expect(readRevocationLog(w.root)).toHaveLength(2);
  });
});

describe("shared vault — credentials and permissions", () => {
  test("missing, malformed, wrong-secret, foreign-store and revoked credentials are all an undifferentiated 401, on every path", async () => {
    const w = world();
    const other = world();
    const paths = ["/v1/whoami", "/v1/feed", "/v1/evidence", "/v1/nope", "/", "/v1/assertions/ast_x"];
    for (const path of paths) {
      for (const token of [undefined, "", "garbage", `sv_${"0".repeat(8)}_secret`, w.alice.slice(0, -4) + "xxxx", other.alice, "bb_12345678_intake-token"]) {
        const res = await call(w.handler, "GET", path, token);
        expect([path, token, res.status]).toEqual([path, token, 401]);
        expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
        expect(await res.text()).toBe('{"error":"unauthorized"}\n');
      }
    }
    // a non-Bearer scheme is nobody too
    const basic = await w.handler(new Request("http://shared.test/v1/whoami", { headers: { Authorization: `Basic ${w.alice}` } }));
    expect(basic.status).toBe(401);
  });

  test("read-only members and read-only credentials cannot write; nothing they send changes the record", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "seed", "seed body for citations");
    const writes: [string, string, unknown][] = [
      ["POST", "/v1/evidence", { title: "x", body: "y" }],
      ["POST", "/v1/assertions", { text: "a claim of some length", sources: [e.id] }],
      ["POST", `/v1/assertions/ast_${"0".repeat(24)}/correct`, { text: "a claim of some length", sources: [e.id] }],
      ["POST", `/v1/assertions/ast_${"0".repeat(24)}/retract`, { reason: "r" }],
      ["POST", "/v1/moderation", { assertion_id: `ast_${"0".repeat(24)}`, reason: "r" }],
    ];
    for (const token of [w.carol, w.aliceReadOnly]) {
      for (const [method, path, body] of writes) {
        const res = await call(w.handler, method, path, token, body);
        expect([path, res.status]).toEqual([path, 403]);
        expect((await asJson(res)).error).toBe("missing permission write");
      }
      // reads still work
      expect((await call(w.handler, "GET", "/v1/feed", token)).status).toBe(200);
      expect((await call(w.handler, "GET", `/v1/evidence/${e.id}`, token)).status).toBe(200);
    }
    expect((await asJson(await call(w.handler, "GET", "/v1/feed", w.alice))).head).toBe(1);
  });

  test("scope escalation: narrowing a member is immediate across credentials; a non-owner cannot moderate; a member cannot correct another's", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "seed", "seed body for citations");
    const a = await assertClaim(w, w.alice, "[[Ada]] said something worth recording.", [e.id]);
    // bob (write) tries to moderate → 403 owner-only; tries to correct alice's → 403 author-only
    const mod = await call(w.handler, "POST", "/v1/moderation", w.bob, { assertion_id: a.id, reason: "no" });
    expect(mod.status).toBe(403);
    expect((await asJson(mod)).error).toMatch(/only the vault owner/u);
    const corr = await call(w.handler, "POST", `/v1/assertions/${a.id}/correct`, w.bob, { text: "[[Ada]] said something else entirely.", sources: [e.id] });
    expect(corr.status).toBe(403);
    expect((await asJson(corr)).error).toMatch(/only its author \(alice\)/u);
    const retract = await call(w.handler, "POST", `/v1/assertions/${a.id}/retract`, w.bob, { reason: "not mine" });
    expect(retract.status).toBe(403);
    // the owner cannot pose as the author either: correction is the author's, moderation is the owner's
    const ownerCorr = await call(w.handler, "POST", `/v1/assertions/${a.id}/correct`, w.owner, { text: "[[Ada]] said something else entirely.", sources: [e.id] });
    expect(ownerCorr.status).toBe(403);
    // alice's agent credential shares her handle — it may correct her assertion, as her delegate
    const agentCorr = await asJson(await call(w.handler, "POST", `/v1/assertions/${a.id}/correct`, w.aliceAgent, { text: "[[Ada]] said something worth recording, twice.", sources: [e.id] }));
    expect(agentCorr.author).toEqual({ kind: "agent", id: "alice" });
    // narrowing alice to read-only refuses her laptop AND her agent on the next request
    setMemberPermissions(w.store, "alice", ["read"]);
    for (const token of [w.alice, w.aliceAgent]) {
      const res = await call(w.handler, "POST", "/v1/evidence", token, { title: "x", body: "y" });
      expect(res.status).toBe(403);
    }
    expect((await asJson(await call(w.handler, "GET", "/v1/whoami", w.aliceAgent))).permissions).toEqual(["read"]);
    // and the record still holds exactly what was written before
    expect(readAssertionLog(w.root, { includeRevoked: true })).toHaveLength(2);
  });

  test("a revocation or narrowing that lands WHILE a request body is uploading refuses that request; nothing lands", async () => {
    const w = world();
    // a body that arrives in two chunks, with the world changing in between
    const streamed = (token: string, between: () => void): Promise<Response> => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            controller.enqueue(new TextEncoder().encode('{"title":"mid-upload","body":"'));
            between();
            sent = true;
          } else {
            controller.enqueue(new TextEncoder().encode('arrived after the change"}'));
            controller.close();
          }
        },
      });
      return w.handler(
        new Request("http://shared.test/v1/evidence", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
          // @ts-expect-error — streaming request bodies need the half-duplex flag
          duplex: "half",
        })
      );
    };
    // control: the same streamed body with nothing changing lands
    expect((await streamed(w.alice, () => {})).status).toBe(201);
    // bob's credential revoked mid-upload
    const revokedMid = await streamed(w.bob, () => revokeCredential(w.store, w.bobCredentialId));
    expect(revokedMid.status).toBe(401);
    // alice narrowed to read mid-upload (her credential is still live)
    const narrowedMid = await streamed(w.aliceAgent, () => setMemberPermissions(w.store, "alice", ["read"]));
    expect(narrowedMid.status).toBe(401);
    expect((await asJson(await call(w.handler, "GET", "/v1/feed", w.owner))).head).toBe(1);
  });

  test("the door never writes the member store: usage lands in the sidecar, so an operator's revoke can never be overwritten by a stale server write", async () => {
    const w = world();
    const before = readFileSync(w.store, "utf8");
    await dropEvidence(w, w.alice, "seed", "seed body for citations");
    await call(w.handler, "GET", "/v1/feed", w.bob);
    await call(w.handler, "GET", "/v1/whoami", w.carol);
    expect(readFileSync(w.store, "utf8")).toBe(before);
    const usage = JSON.parse(readFileSync(usagePath(w.store), "utf8"));
    const aliceLaptop = listCredentials(w.store, "alice").find((c) => c.name === "laptop")!;
    expect(Object.keys(usage).sort()).toEqual([w.bobCredentialId, aliceLaptop.id].sort()); // whoami does not touch
    expect(aliceLaptop.last_used).toBeString();
    expect(listCredentials(w.store, "carol")[0]!.last_used).toBeNull();
  });
});

describe("shared vault — forged authorship and delegation", () => {
  test("a body that names an author, actor, submitter or delegation is refused, and nothing lands", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "seed", "seed body for citations");
    const forged: [string, unknown][] = [
      ["/v1/evidence", { title: "x", body: "y", author: { kind: "user", id: "owner" } }],
      ["/v1/evidence", { title: "x", body: "y", submitted_by: "owner" }],
      ["/v1/evidence", { title: "x", body: "y", on_behalf_of: "owner" }],
      ["/v1/evidence", { title: "x", body: "y", actor: "owner" }],
      ["/v1/evidence", { title: "x", body: "y", id: "ins_000000000000000000000000" }],
      ["/v1/evidence", { title: "x", body: "y", origin: { author: "grace", author_verified: true } }],
      ["/v1/evidence", { title: "x", body: "y", origin: { submitted_by: "owner" } }],
      ["/v1/evidence", { title: "x", body: "y", envelope: { from: "owner" } }],
      ["/v1/assertions", { text: "a claim of some length", sources: [e.id], author: { kind: "user", id: "owner" } }],
      ["/v1/assertions", { text: "a claim of some length", sources: [e.id], produced_by: { procedure: "x", version: "1" } }],
      ["/v1/assertions", { text: "a claim of some length", sources: [e.id], created_at: "2000-01-01T00:00:00Z" }],
      ["/v1/assertions", { text: "a claim of some length", sources: [e.id], supersedes: `ast_${"0".repeat(24)}` }],
      ["/v1/assertions", { text: "a claim of some length", sources: [e.id], entities: [{ id: `ent_${"0".repeat(20)}`, label: "x" }] }],
      ["/v1/moderation", { assertion_id: `ast_${"0".repeat(24)}`, reason: "r", author: { kind: "user", id: "alice" } }],
    ];
    for (const [path, body] of forged) {
      const res = await call(w.handler, "POST", path, path === "/v1/moderation" ? w.owner : w.alice, body);
      const j = await asJson(res);
      expect([path, res.status, j.error]).toEqual([path, 400, expect.stringMatching(/forged authorship/u)]);
    }
    expect((await asJson(await call(w.handler, "GET", "/v1/feed", w.alice))).head).toBe(1);
    expect(readAssertionLog(w.root, { includeRevoked: true })).toHaveLength(0);
  });

  test("an agent credential writes as the member's delegate: kind agent, the member's handle, never a person's voice", async () => {
    const w = world();
    const e = await dropEvidence(w, w.aliceAgent, "Alice's own words, submitted by her assistant", "alice: ship the probe on Friday.");
    const ev = await asJson(await call(w.handler, "GET", `/v1/evidence/${e.id}`, w.alice));
    expect(ev.author).toEqual({ kind: "agent", id: "alice" });
    expect(ev.envelope).toMatchObject({ submitted_by: "alice", submitted_kind: "agent" });
    // the claimed origin author is alice herself, but an agent said so — unverified
    expect(ev.envelope.origin).toMatchObject({ author: "alice", author_verified: false });
    const a = await assertClaim(w, w.aliceAgent, "[[Alice]] plans to ship the probe on Friday.", [e.id]);
    expect((await asJson(await call(w.handler, "GET", `/v1/assertions/${a.id}`, w.alice))).assertion.author).toEqual({ kind: "agent", id: "alice" });
    // a claimed origin author who is another member is still just a claim
    const e2 = await dropEvidence(w, w.bob, "Alice's note (forwarded by bob)", "alice apparently said: no probes on Friday.", { author: "alice" });
    const ev2 = await asJson(await call(w.handler, "GET", `/v1/evidence/${e2.id}`, w.alice));
    expect(ev2.author).toEqual({ kind: "user", id: "bob" });
    expect(ev2.envelope.origin).toMatchObject({ author: "alice", author_verified: false });
    expect(ev2.envelope.submitted_by).toBe("bob");
  });
});

describe("shared vault — citations, ids and paths", () => {
  test("invalid citations are refused: malformed ids, unknown insertions, empty, too many, non-strings", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "seed", "seed body for citations");
    const bad: [unknown, RegExp][] = [
      [[], /sources must list/u],
      [undefined, /sources must list/u],
      [["ins_000000000000000000000000"], /no evidence ins_0000/u],
      [["../../etc/passwd"], /invalid citation/u],
      [["log/insertions/undated/x.json"], /invalid citation/u],
      [[e.id, 42], /invalid citation/u],
      [Array.from({ length: 21 }, () => e.id), /sources must list 1-20/u],
    ];
    for (const [sources, re] of bad) {
      const res = await call(w.handler, "POST", "/v1/assertions", w.alice, { text: "a claim of some length", ...(sources !== undefined ? { sources } : {}) });
      expect(res.status).toBe(400);
      expect((await asJson(res)).error).toMatch(re);
    }
    // mismatched entity ids: ids are derived from labels
    const res = await call(w.handler, "POST", "/v1/assertions", w.alice, { text: `[[ent_${"0".repeat(20)}|Ada]] said something.`, sources: [e.id] });
    expect(res.status).toBe(400);
    expect((await asJson(res)).error).toMatch(/derived from labels/u);
    expect(readAssertionLog(w.root, { includeRevoked: true })).toHaveLength(0);
  });

  test("ids that are not ids never become paths: traversal, encoded traversal, absolute paths, log-relative paths", async () => {
    const w = world();
    const probes = [
      "/v1/evidence/..%2F..%2Fvault.yaml",
      "/v1/evidence/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
      "/v1/evidence/%2Fetc%2Fpasswd",
      "/v1/evidence/ins_000000000000000000000000%2F..%2F..%2Fx",
      "/v1/evidence/log%2Finsertions%2Fundated%2Fx.json",
      "/v1/assertions/..%2F..%2Fmembers.json",
      "/v1/assertions/ast_zz",
      "/v1/assertions/ast_000000000000000000000000%00",
    ];
    for (const path of probes) {
      const res = await call(w.handler, "GET", path, w.alice);
      expect([path, res.status]).toEqual([path, 400]);
    }
    // a literal `..` is collapsed by URL parsing into a path that is not on the table
    expect((await call(w.handler, "GET", "/v1/evidence/../../vault.yaml", w.alice)).status).toBe(404);
    // a well-formed id that does not exist is 404 — distinct from a bad id on purpose
    expect((await call(w.handler, "GET", `/v1/evidence/ins_${"a".repeat(24)}`, w.alice)).status).toBe(404);
    expect((await call(w.handler, "GET", `/v1/assertions/ast_${"a".repeat(24)}`, w.alice)).status).toBe(404);
  });

  test("the surface is the table: every entry answers with a credential, nothing outside it does, and unauth is 401 everywhere", async () => {
    const w = world();
    const e = await dropEvidence(w, w.owner, "seed", "seed body for the table walk");
    const a = await assertClaim(w, w.owner, "[[Ada]] seeds the table walk.", [e.id]);
    for (const route of SHARED_ROUTES) {
      const path = route.path.replace(":id", route.path.includes("evidence") ? e.id : a.id);
      const res = await call(w.handler, route.method, path, w.owner, route.method === "POST" ? {} : undefined);
      expect([route.method, path, res.status]).not.toEqual([route.method, path, 404]);
      expect((await call(w.handler, route.method, path)).status).toBe(401);
    }
    for (const [method, path] of [["DELETE", "/v1/evidence"], ["PUT", "/v1/assertions"], ["GET", "/v1/members"], ["POST", "/v1/members"], ["GET", "/api/vault"], ["GET", "/v1/memory"], ["GET", "/v1/note?path=vault.yaml"]]) {
      expect((await call(w.handler, method!, path!, w.owner)).status).toBe(404);
    }
  });

  test("evidence and assertion bodies are validated and bounded; wrong content type is 415", async () => {
    const w = world();
    const cases: [string, unknown, number, RegExp][] = [
      ["/v1/evidence", { body: "y" }, 400, /title must be/u],
      ["/v1/evidence", { title: "x", body: "" }, 400, /body must be/u],
      ["/v1/evidence", { title: "x", body: "y", extra: 1 }, 400, /unknown evidence field/u],
      ["/v1/evidence", { title: "x", body: "y", origin: { url: "javascript:alert(1)" } }, 400, /http\(s\) URL/u],
      ["/v1/evidence", { title: "x", body: "y", origin: { date: "yesterday" } }, 400, /origin.date/u],
      ["/v1/evidence", { title: "x", body: "y", origin: { kind: "Not A Slug" } }, 400, /origin.kind/u],
      ["/v1/evidence", { title: "x", body: "y", origin: { steer: "the model" } }, 400, /unknown origin field/u],
      ["/v1/evidence", { title: "x", body: "y".repeat(1024 * 1024 + 1) }, 413, /exceeds/u],
      ["/v1/evidence", [], 400, /JSON object/u],
      ["/v1/evidence", "null", 400, /JSON object/u],
      ["/v1/evidence", "{not json", 400, /bad JSON/u],
      ["/v1/assertions", { text: "short", sources: [`ins_${"a".repeat(24)}`] }, 400, /12-2000/u],
      ["/v1/assertions", { text: "a claim\nwith a newline in it", sources: [`ins_${"a".repeat(24)}`] }, 400, /no evidence|12-2000/u],
      ["/v1/assertions", { text: "a claim of some length", sources: [`ins_${"a".repeat(24)}`], confidence: "sure" }, 400, /confidence/u],
      ["/v1/moderation", { assertion_id: "nope", reason: "r" }, 400, /assertion_id/u],
      ["/v1/moderation", { assertion_id: `ast_${"a".repeat(24)}`, reason: "" }, 400, /reason/u],
      ["/v1/moderation", { assertion_id: `ast_${"a".repeat(24)}`, reason: "r" }, 404, /no assertion/u],
    ];
    for (const [path, body, status, re] of cases) {
      const res = await call(w.handler, "POST", path, w.owner, body);
      const j = await asJson(res);
      expect([path, res.status, j.error]).toEqual([path, status, expect.stringMatching(re)]);
    }
    const text = await w.handler(new Request("http://shared.test/v1/evidence", { method: "POST", headers: { Authorization: `Bearer ${w.owner}`, "Content-Type": "text/plain" }, body: "hello" }));
    expect(text.status).toBe(415);
    // nothing landed: no log directory was even created
    expect(readdirSync(w.root)).toEqual([]);
  });
});

describe("shared vault — idempotency, concurrency, persistence, pagination", () => {
  test("a retried submission converges on the same event and does not re-enter the feed", async () => {
    let t = 0;
    const w = world({ now: () => new Date(1_800_000_000_000 + 1000 * t++) });
    const a = await dropEvidence(w, w.alice, "same", "same body");
    const b = await dropEvidence(w, w.alice, "same", "same body");
    expect(b).toMatchObject({ id: a.id, deduped: true, seq: a.seq }); // the ORIGINAL entry's seq
    // the same words from a different submitter are a different insertion of the same source
    const c = await dropEvidence(w, w.bob, "same", "same body", { author: "alice" });
    expect(c.source_id).toBe(a.source_id);
    expect(c.id).not.toBe(a.id);
    const x = await assertClaim(w, w.alice, "[[Ada]] agrees with the same body.", [a.id]);
    const y = await assertClaim(w, w.alice, "[[Ada]] agrees with the same body.", [a.id]); // later created_at, same id
    expect(y).toMatchObject({ id: x.id, deduped: true, seq: x.seq });
    expect((await call(w.handler, "POST", "/v1/assertions", w.alice, { text: "[[Ada]] agrees with the same body.", sources: [a.id] })).status).toBe(200);
    // the same words from bob are bob's own assertion
    const z = await assertClaim(w, w.bob, "[[Ada]] agrees with the same body.", [a.id]);
    expect(z.id).not.toBe(x.id);
    // a retried correction converges too
    const c1 = await asJson(await call(w.handler, "POST", `/v1/assertions/${x.id}/correct`, w.alice, { text: "[[Ada]] agrees with the same body, mostly.", sources: [a.id] }));
    const c2 = await call(w.handler, "POST", `/v1/assertions/${x.id}/correct`, w.alice, { text: "[[Ada]] agrees with the same body, mostly.", sources: [a.id] });
    expect(c2.status).toBe(409); // already corrected: the record says so rather than pretending
    expect((await asJson(c2)).error).toContain(c1.id);
    const feed = await asJson(await call(w.handler, "GET", "/v1/feed", w.alice));
    expect(feed.entries.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(readdirSync(join(w.root, "log", "assertions")).length).toBe(1); // one month dir
  });

  test("concurrent writes: distinct items all land with contiguous unique sequence numbers; identical ones land once", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "seed", "seed body for citations");
    const distinct = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        call(w.handler, "POST", "/v1/assertions", i % 2 ? w.alice : w.bob, { text: `[[Ada]] noted item number ${i} in the concurrent batch.`, sources: [e.id] })
      )
    );
    const bodies = await Promise.all(distinct.map(asJson));
    expect(distinct.every((r) => r.status === 201)).toBe(true);
    const seqs = bodies.map((b) => b.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 2));
    const same = await Promise.all(
      Array.from({ length: 10 }, () => call(w.handler, "POST", "/v1/evidence", w.alice, { title: "race", body: "the same evidence ten times at once" }))
    );
    const sameBodies = await Promise.all(same.map(asJson));
    expect(sameBodies.filter((b) => !b.deduped)).toHaveLength(1);
    expect(new Set(sameBodies.map((b) => b.id)).size).toBe(1);
    const feed = await asJson(await call(w.handler, "GET", "/v1/feed?limit=200", w.alice));
    expect(feed.head).toBe(27);
    expect(feed.entries.map((x: any) => x.seq)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    // every feed entry points at an event file that exists
    for (const entry of feed.entries) expect(existsSync(join(w.root, entry.path))).toBe(true);
  });

  test("restart persistence: a fresh handler over the same directory sees every event, the feed head, and continues the sequence", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "before restart", "body before restart");
    const a = await assertClaim(w, w.alice, "[[Ada]] wrote this before the restart.", [e.id]);
    const again = makeSharedApiHandler({ root: w.root, storePath: w.store, log: () => {} });
    const view = await asJson(await again(new Request(`http://shared.test/v1/assertions/${a.id}`, { headers: { Authorization: `Bearer ${w.bob}` } })));
    expect(view.assertion.author.id).toBe("alice");
    const feed = await asJson(await again(new Request("http://shared.test/v1/feed", { headers: { Authorization: `Bearer ${w.bob}` } })));
    expect(feed.head).toBe(2);
    const more = await again(new Request("http://shared.test/v1/evidence", { method: "POST", headers: { Authorization: `Bearer ${w.bob}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "after restart", body: "body after restart" }) }));
    expect((await asJson(more)).seq).toBe(3);
    // and the retry of a pre-restart submission still dedupes across the restart
    const retry = await again(new Request("http://shared.test/v1/assertions", { method: "POST", headers: { Authorization: `Bearer ${w.alice}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "[[Ada]] wrote this before the restart.", sources: [e.id] }) }));
    expect(await asJson(retry)).toMatchObject({ id: a.id, deduped: true });
    // the feed file is the durable order: one line per event, in sequence
    const lines = readFileSync(join(w.root, SHARED_FEED_DIR, "feed.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  test("a crash between the event append and its feed line heals on retry: the event gets a feed entry instead of never", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "seed", "seed body for citations");
    const a = await assertClaim(w, w.alice, "[[Ada]] landed but never reached the feed.", [e.id]);
    expect(a.seq).toBe(2);
    // simulate the crash: the assertion file stays, its feed line is gone
    const feedPath = join(w.root, SHARED_FEED_DIR, "feed.ndjson");
    writeFileSync(feedPath, readFileSync(feedPath, "utf8").split("\n")[0] + "\n");
    const fresh = makeSharedApiHandler({ root: w.root, storePath: w.store, log: () => {} });
    expect(new SharedVault(w.root).missingFromFeed()).toEqual([a.id]);
    const retry = await asJson(await fresh(new Request("http://shared.test/v1/assertions", { method: "POST", headers: { Authorization: `Bearer ${w.alice}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "[[Ada]] landed but never reached the feed.", sources: [e.id] }) })));
    expect(retry).toMatchObject({ id: a.id, deduped: false, seq: 2 }); // the feed line is new work; the event was not
    expect(new SharedVault(w.root).missingFromFeed()).toEqual([]);
    expect(readAssertionLog(w.root)).toHaveLength(1);
    const again = await asJson(await fresh(new Request("http://shared.test/v1/assertions", { method: "POST", headers: { Authorization: `Bearer ${w.alice}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "[[Ada]] landed but never reached the feed.", sources: [e.id] }) })));
    expect(again).toMatchObject({ id: a.id, deduped: true, seq: 2 });
  });

  test("concurrent corrections of one assertion by its author: exactly one wins, the other is told what stands", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "seed", "seed body for citations");
    const a = await assertClaim(w, w.alice, "[[Ada]] will be corrected twice at once.", [e.id]);
    const [r1, r2] = await Promise.all([
      call(w.handler, "POST", `/v1/assertions/${a.id}/correct`, w.alice, { text: "[[Ada]] will be corrected: version one.", sources: [e.id] }),
      call(w.handler, "POST", `/v1/assertions/${a.id}/correct`, w.aliceAgent, { text: "[[Ada]] will be corrected: version two.", sources: [e.id] }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const view = await asJson(await call(w.handler, "GET", `/v1/assertions/${a.id}`, w.bob));
    expect(view.revocation.superseded_by).toBe(view.resolved_id);
    expect(readRevocationLog(w.root)).toHaveLength(1);
  });

  test("feed pagination and resume: bounded pages, cursors that continue, a torn tail that is ignored, and bad cursors refused", async () => {
    const w = world();
    const e = await dropEvidence(w, w.alice, "seed", "seed body for citations");
    for (let i = 0; i < 9; i++) await assertClaim(w, w.alice, `[[Ada]] item ${i} for the pagination test.`, [e.id]);
    const p1 = await asJson(await call(w.handler, "GET", "/v1/feed?after=0&limit=4", w.carol));
    expect(p1.entries.map((x: any) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(p1).toMatchObject({ next_cursor: 4, has_more: true, head: 10 });
    const p2 = await asJson(await call(w.handler, "GET", `/v1/feed?after=${p1.next_cursor}&limit=4`, w.carol));
    expect(p2.entries.map((x: any) => x.seq)).toEqual([5, 6, 7, 8]);
    const p3 = await asJson(await call(w.handler, "GET", `/v1/feed?after=${p2.next_cursor}&limit=4`, w.carol));
    expect(p3.entries.map((x: any) => x.seq)).toEqual([9, 10]);
    expect(p3).toMatchObject({ next_cursor: 10, has_more: false });
    const p4 = await asJson(await call(w.handler, "GET", "/v1/feed?after=10", w.carol));
    expect(p4).toMatchObject({ entries: [], next_cursor: 10, has_more: false, head: 10 });
    const beyond = await asJson(await call(w.handler, "GET", "/v1/feed?after=999", w.carol));
    expect(beyond).toMatchObject({ entries: [], next_cursor: 10, has_more: false });
    for (const q of ["after=-1", "after=x", "limit=0", "limit=201", "after=1.5"]) {
      expect((await call(w.handler, "GET", `/v1/feed?${q}`, w.carol)).status).toBe(400);
    }
    // a torn tail (a crash mid-append) is not part of the feed, and the next append continues after the last complete line
    writeFileSync(join(w.root, SHARED_FEED_DIR, "feed.ndjson"), '{"seq":11,"kind":"evid', { flag: "a" });
    expect((await asJson(await call(w.handler, "GET", "/v1/feed?after=9", w.carol))).entries.map((x: any) => x.seq)).toEqual([10]);
    const next = await dropEvidence(w, w.bob, "after the tear", "a new line after a torn one");
    expect(next.seq).toBe(11);
    const tail = await asJson(await call(w.handler, "GET", "/v1/feed?after=9", w.carol));
    expect(tail.entries.map((x: any) => x.seq)).toEqual([10, 11]);

    // list pagination over assertions
    const l1 = await asJson(await call(w.handler, "GET", "/v1/assertions?limit=4", w.carol));
    expect(l1.items).toHaveLength(4);
    expect(l1.next_cursor).toBeString();
    const l2 = await asJson(await call(w.handler, "GET", `/v1/assertions?limit=4&cursor=${encodeURIComponent(l1.next_cursor)}`, w.carol));
    const l3 = await asJson(await call(w.handler, "GET", `/v1/assertions?limit=4&cursor=${encodeURIComponent(l2.next_cursor)}`, w.carol));
    expect(l3.items).toHaveLength(1);
    expect(l3.next_cursor).toBeNull();
    const ids = [...l1.items, ...l2.items, ...l3.items].map((v: any) => v.assertion.id);
    expect(new Set(ids).size).toBe(9);
    expect((await call(w.handler, "GET", "/v1/assertions?limit=4&cursor=%00", w.carol)).status).toBe(400);
    const ev = await asJson(await call(w.handler, "GET", "/v1/evidence?limit=1", w.carol));
    expect(ev.items).toHaveLength(1);
    expect(ev.next_cursor).toBeString();
  });

  test("the SharedVault reads only its logs: nothing else under the root is reachable, and the handler never writes outside log/", async () => {
    const w = world();
    writeFileSync(join(w.root, "secret.md"), "the operator's private note");
    await dropEvidence(w, w.alice, "seed", "seed body for citations");
    const hits = (await asJson(await call(w.handler, "GET", "/v1/search?q=private%20note", w.alice))).hits;
    expect(hits).toEqual([]);
    expect(readdirSync(w.root).sort()).toEqual(["log", "secret.md"]);
    expect(readdirSync(join(w.root, "log")).sort()).toEqual(["insertions", "shared-feed"]);
    const v = new SharedVault(w.root);
    expect(v.head()).toBe(1);
  });
});
