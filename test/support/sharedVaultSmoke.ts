/**
 * sharedVaultSmoke.ts — the shared vault's owner / alice / bob scenario,
 * runnable by hand against a scratch directory (docs/shared-vault.md):
 *
 *   bun test/support/sharedVaultSmoke.ts --dir /path/to/scratch            # in-process handler, no socket
 *   bun test/support/sharedVaultSmoke.ts --dir /path/to/scratch --http     # real HTTP: spawns `bin/shared.ts serve` on 127.0.0.1:0
 *   bun test/support/sharedVaultSmoke.ts --url http://127.0.0.1:4749 \
 *       --vault <dir> --members <file> --owner sv_… --alice sv_… --bob sv_…  # the scenario alone, against a server you started
 *
 * Four phases, each a check that exits non-zero on its first failure:
 *
 *   1. scenario     provision through the REAL entrypoint (`bigbrain shared
 *                   init` via bin/cli.ts, then bin/shared.ts member add /
 *                   credential mint), drop evidence, assert with citations,
 *                   read, search, correct, revoke bob, moderate, dedupe;
 *   2. persistence  stop the server (SIGTERM) and start another over the
 *                   same directory; then kill -9 it and start a third —
 *                   the record, the revocation and the feed's sequence
 *                   survive both, a client resumes from its cursor, and a
 *                   pre-restart retry still dedupes;
 *   3. clients      a SECOND, independent client (`curl`, one process per
 *                   request) reads what the first wrote and writes what
 *                   the first reads; the two write concurrently and every
 *                   event gets one contiguous sequence number;
 *   4. adversarial  every authorization attack the door must refuse, over
 *                   the transport under test, and the feed head at the end
 *                   proves nothing refused ever landed.
 *
 * Phases 2 and 3 need a real process on a real socket. In handler mode
 * phase 2 restarts by opening a fresh handler over the directory (that IS
 * what a restart does to the record) and phase 3 is reported SKIPPED, not
 * passed: an in-process Request is not a second client.
 *
 * bun test does not collect this file (not *.test.ts);
 * test/sharedVaultServer.test.ts imports from it.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flagValue, hasFlag } from "../../lib/cliflags";
import { ENGINE_ROOT } from "../../lib/engine";
import { makeSharedApiHandler, MAX_SHARED_REQUEST_BYTES } from "../../lib/sharedVaultApi";

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

const SHARED_BIN = join(ENGINE_ROOT, "bin", "shared.ts");
const CLI_BIN = join(ENGINE_ROOT, "bin", "cli.ts");

const childEnv = (): Record<string, string | undefined> => ({ ...process.env, PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

/** Run `bin/shared.ts` with `--json`, parse its one-line answer. `via: "cli"`
 * goes through `bin/cli.ts shared …` — the installed `bigbrain` command. */
export function sharedCli(args: string[], opts: { expectFail?: boolean; via?: "shared" | "cli" } = {}): { code: number; out: string; err: string; json: any } {
  const argv = opts.via === "cli" ? [CLI_BIN, "shared", ...args, "--json"] : [SHARED_BIN, ...args, "--json"];
  const r = Bun.spawnSync([process.execPath, ...argv], { stdout: "pipe", stderr: "pipe", env: childEnv() });
  const out = r.stdout.toString();
  const err = r.stderr.toString();
  if (!opts.expectFail && r.exitCode !== 0) throw new Error(`bin/shared.ts ${args.join(" ")} exited ${r.exitCode}: ${err || out}`);
  let json: any = null;
  try {
    json = JSON.parse(out.trim().split("\n").at(-1) ?? "");
  } catch {
    /* not JSON — a refusal or usage */
  }
  return { code: r.exitCode ?? -1, out, err, json };
}

export interface Provisioned {
  root: string;
  store: string;
  owner: string;
  alice: string;
  bob: string;
  /** carol: a read-only member */
  carol: string;
  /** alice's read-scoped credential (her member holds write) */
  aliceReadOnly: string;
  aliceCredentialId: string;
}

/** The provisioning half of the scenario, through the real CLI. `init`
 * goes through bin/cli.ts (the `bigbrain` command); the rest through
 * bin/shared.ts, which is what cli.ts dispatches to. */
export function provision(dir: string): Provisioned {
  const root = join(dir, "shared-vault");
  const store = join(dir, "members.json");
  mkdirSync(dir, { recursive: true });
  const init = sharedCli(["init", "--vault", root, "--members", store, "--owner", "owner", "--display", "The Owner"], { via: "cli" }).json;
  if (!init?.token) throw new Error("bigbrain shared init (via bin/cli.ts) did not print a credential");
  const v = ["--vault", root, "--members", store];
  sharedCli(["member", "add", "alice", ...v, "--display", "Alice", "--permissions", "read,write"]);
  sharedCli(["member", "add", "bob", ...v, "--display", "Bob", "--permissions", "read,write"]);
  sharedCli(["member", "add", "carol", ...v, "--display", "Carol", "--permissions", "read"]);
  const alice = sharedCli(["credential", "mint", "alice", ...v, "--name", "laptop"]).json;
  const aliceReadOnly = sharedCli(["credential", "mint", "alice", ...v, "--name", "viewer", "--scopes", "read"]).json;
  const bob = sharedCli(["credential", "mint", "bob", ...v, "--name", "phone"]).json;
  const carol = sharedCli(["credential", "mint", "carol", ...v, "--name", "tablet"]).json;
  return { root, store, owner: init.token, alice: alice.token, bob: bob.token, carol: carol.token, aliceReadOnly: aliceReadOnly.token, aliceCredentialId: alice.credential.id };
}

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`smoke: ${what}`);
}

type Api = (method: string, path: string, token: string | undefined, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any; headers: Headers }>;

const apiOver =
  (fetcher: Fetcher): Api =>
  async (method, path, token, body, headers = {}) => {
    const res = await fetcher(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, headers: res.headers };
  };

/** A run's server, however it is reached. */
export interface Session {
  mode: "handler" | "http";
  fetcher: Fetcher;
  /** A second, independent client — `curl`, one process per request. */
  alt?: Fetcher;
  /** Stop cleanly and start again over the same directory. */
  restart: () => Promise<void>;
  /** Die without cleanup (SIGKILL) and start again. */
  crash: () => Promise<void>;
}

// ── phase 1: the scenario ───────────────────────────────────────────────────

/** The scenario proper, against any fetcher. `revokeBob` is how this run
 * revokes a member (the CLI in the real modes). Returns a line-per-step
 * report and the ids later phases build on. */
export async function runSmoke(
  fetcher: Fetcher,
  tokens: { owner: string; alice: string; bob: string },
  revokeBob: () => void
): Promise<string[]> {
  const r = await runScenario(fetcher, tokens, revokeBob);
  return r.report;
}

export interface ScenarioIds {
  e1: string;
  e2: string;
  a1: string;
  a2: string;
  corr: string;
  head: number;
}

export async function runScenario(
  fetcher: Fetcher,
  tokens: { owner: string; alice: string; bob: string },
  revokeBob: () => void
): Promise<{ report: string[]; ids: ScenarioIds }> {
  const report: string[] = [];
  const api = apiOver(fetcher);
  const step = (line: string): void => {
    report.push(line);
  };

  const anon = await api("GET", "/v1/whoami", undefined);
  check(anon.status === 401, `unauthenticated whoami must be 401, got ${anon.status}`);
  step("unauthenticated request → 401");

  const who = await api("GET", "/v1/whoami", tokens.alice);
  check(who.status === 200 && who.json.handle === "alice" && who.json.permissions.includes("write"), "alice whoami");
  step(`alice whoami → ${who.json.handle} (${who.json.role}, ${who.json.permissions.join("+")})`);

  const e1 = await api("POST", "/v1/evidence", tokens.alice, { title: "Atlas kickoff notes", body: "The Atlas experiment should test sparse probes first, said Ada." });
  check(e1.status === 201 && e1.json.seq === 1, `alice evidence: ${e1.status} ${JSON.stringify(e1.json)}`);
  step(`alice drops evidence → ${e1.json.id} seq ${e1.json.seq}`);
  const e2 = await api("POST", "/v1/evidence", tokens.bob, {
    title: "Fwd: Atlas budget", body: "Grace wrote: the Atlas budget is capped at 40 units this quarter.",
    origin: { id: "msg-2026-0001@example.test", author: "grace", kind: "email", date: "2026-03-04" },
  });
  check(e2.status === 201 && e2.json.source_id === "origin:msg-2026-0001@example.test" && e2.json.origin.author === "grace" && e2.json.origin.author_verified === false, `bob evidence: ${JSON.stringify(e2.json)}`);
  step(`bob drops forwarded evidence → ${e2.json.id} (origin ${e2.json.source_id}, claimed author grace, submitted_by ${e2.json.submitted_by})`);

  const forged = await api("POST", "/v1/evidence", tokens.bob, { title: "x", body: "y", submitted_by: "owner" });
  check(forged.status === 400 && /forged authorship/u.test(forged.json.error), "forged submitter must be refused");
  step("bob names a submitter in the body → 400 forged authorship");

  const a1 = await api("POST", "/v1/assertions", tokens.alice, { text: "[[Ada]] wants [[Atlas]] to test sparse probes first.", sources: [e1.json.id] });
  check(a1.status === 201 && a1.json.author.id === "alice", `alice assert: ${JSON.stringify(a1.json)}`);
  step(`alice asserts with a valid citation → ${a1.json.id}`);
  const a2 = await api("POST", "/v1/assertions", tokens.bob, { text: "[[Atlas]] has a budget cap of 40 units this quarter.", sources: [e2.json.id] });
  check(a2.status === 201, `bob assert: ${JSON.stringify(a2.json)}`);
  step(`bob asserts → ${a2.json.id}`);
  const badCite = await api("POST", "/v1/assertions", tokens.bob, { text: "[[Atlas]] has no budget at all this quarter.", sources: [`ins_${"0".repeat(24)}`] });
  check(badCite.status === 400 && /invalid citation/u.test(badCite.json.error), "invalid citation must be refused");
  step("bob cites evidence that does not exist → 400 invalid citation");
  const traversal = await api("GET", "/v1/evidence/..%2F..%2Fmembers.json", tokens.bob);
  check(traversal.status === 400, `traversal must be 400, got ${traversal.status}`);
  step("bob reads ../../members.json → 400 (never a path)");

  const read = await api("GET", `/v1/assertions/${a1.json.id}`, tokens.bob);
  check(read.status === 200 && read.json.assertion.author.id === "alice" && read.json.revocation === null, "read alice's assertion");
  step(`bob reads alice's assertion → author ${read.json.assertion.author.id}, live`);
  const search = await api("GET", "/v1/search?q=atlas%20budget", tokens.alice);
  check(search.status === 200 && search.json.hits.some((h: any) => h.id === a2.json.id) && search.json.hits.some((h: any) => h.id === e2.json.id), "search finds both");
  step(`alice searches "atlas budget" → ${search.json.hits.length} hits (evidence + assertion)`);

  const cross = await api("POST", `/v1/assertions/${a1.json.id}/correct`, tokens.bob, { text: "[[Ada]] wants [[Atlas]] to test dense probes first.", sources: [e1.json.id] });
  check(cross.status === 403, `cross-member correction must be 403, got ${cross.status}`);
  step("bob tries to correct alice's assertion → 403");
  const corr = await api("POST", `/v1/assertions/${a1.json.id}/correct`, tokens.alice, { text: "[[Ada]] wants [[Atlas]] to test sparse probes before dense ones.", sources: [e1.json.id], reason: "more precise" });
  check(corr.status === 201 && corr.json.supersedes === a1.json.id, `alice correct: ${JSON.stringify(corr.json)}`);
  const old = await api("GET", `/v1/assertions/${a1.json.id}`, tokens.bob);
  check(old.json.revocation?.superseded_by === corr.json.id && old.json.revocation.author.id === "alice" && old.json.resolved_id === corr.json.id, "old assertion resolves to the correction");
  step(`alice corrects her own assertion → ${corr.json.id} supersedes ${a1.json.id}; revocation ${corr.json.revocation} by alice`);

  const notOwner = await api("POST", "/v1/moderation", tokens.bob, { assertion_id: a2.json.id, reason: "x" });
  check(notOwner.status === 403, "member moderation must be 403");
  step("bob tries to moderate → 403 (owner only)");

  const feed1 = await api("GET", "/v1/feed?after=0&limit=3", tokens.bob);
  check(feed1.status === 200 && feed1.json.entries.length === 3 && feed1.json.has_more === true, "feed page 1");
  const feed2 = await api("GET", `/v1/feed?after=${feed1.json.next_cursor}&limit=100`, tokens.bob);
  check(feed2.json.entries[0].seq === 4 && feed2.json.has_more === false && feed2.json.head === 6, `feed page 2: ${JSON.stringify(feed2.json)}`);
  step(`feed resumes: page 1 seq 1-3, page 2 seq 4-${feed2.json.head}`);

  revokeBob();
  const revoked = await api("GET", "/v1/whoami", tokens.bob);
  check(revoked.status === 401, `revoked bob must be 401, got ${revoked.status}`);
  const revokedWrite = await api("POST", "/v1/evidence", tokens.bob, { title: "x", body: "y" });
  check(revokedWrite.status === 401, "revoked bob write must be 401");
  step("owner revokes bob → bob's next read and write are 401");

  const mod = await api("POST", "/v1/moderation", tokens.owner, { assertion_id: a2.json.id, reason: "unverifiable forward" });
  check(mod.status === 201 && mod.json.author.id === "owner" && mod.json.procedure === "shared-vault/moderation", `moderation: ${JSON.stringify(mod.json)}`);
  const moderated = await api("GET", `/v1/assertions/${a2.json.id}`, tokens.alice);
  check(moderated.json.assertion.author.id === "bob" && moderated.json.revocation.author.id === "owner", "moderation attributed to owner, assertion still bob's");
  step(`owner moderates bob's assertion → revocation ${mod.json.revocation} by owner (bob's authorship intact)`);

  const retry = await api("POST", "/v1/evidence", tokens.alice, { title: "Atlas kickoff notes", body: "The Atlas experiment should test sparse probes first, said Ada." });
  check(retry.status === 200 && retry.json.deduped === true && retry.json.id === e1.json.id, "retry dedupes");
  step("alice re-sends her first drop → 200 deduped, same id, no new feed entry");
  const head = await api("GET", "/v1/feed?after=0&limit=1", tokens.alice);
  check(head.json.head === 7, `head must be 7, got ${head.json.head}`);
  step(`feed head ${head.json.head}`);
  return { report, ids: { e1: e1.json.id, e2: e2.json.id, a1: a1.json.id, a2: a2.json.id, corr: corr.json.id, head: 7 } };
}

// ── phase 2: restart and crash persistence ──────────────────────────────────

export async function runPersistence(session: Session, p: Provisioned, ids: ScenarioIds): Promise<string[]> {
  const report: string[] = [];
  const api = apiOver(session.fetcher);
  const lock = join(p.root, ".state", "shared-server.lock");

  await session.restart();
  if (session.mode === "http") check(existsSync(lock) && readFileSync(join(lock, "pid"), "utf8").trim() !== "", "a live server holds the lock");
  report.push(session.mode === "http" ? "SIGTERM the server, start another over the same directory" : "open a fresh handler over the same directory (what a restart does to the record)");

  check((await api("GET", "/v1/whoami", p.alice)).status === 200, "alice still verifies after restart");
  check((await api("GET", "/v1/whoami", p.bob)).status === 401, "bob's revocation survives the restart");
  report.push("after restart: alice → 200, revoked bob → 401");

  const resume = await api("GET", "/v1/feed?after=5", p.alice);
  check(resume.status === 200 && resume.json.head === ids.head && resume.json.entries.map((e: any) => e.seq).join() === "6,7" && resume.json.has_more === false, `feed resume from 5: ${JSON.stringify(resume.json)}`);
  const page1 = await api("GET", "/v1/feed?after=0&limit=2", p.alice);
  const page2 = await api("GET", `/v1/feed?after=${page1.json.next_cursor}&limit=2`, p.alice);
  const page3 = await api("GET", `/v1/feed?after=${page2.json.next_cursor}&limit=2`, p.alice);
  const page4 = await api("GET", `/v1/feed?after=${page3.json.next_cursor}&limit=2`, p.alice);
  const walked = [...page1.json.entries, ...page2.json.entries, ...page3.json.entries, ...page4.json.entries].map((e: any) => e.seq);
  check(walked.join() === "1,2,3,4,5,6,7" && page4.json.has_more === false && page4.json.next_cursor === 7, `feed walk in pages of 2: ${walked.join()}`);
  const beyond = await api("GET", "/v1/feed?after=999999", p.alice);
  check(beyond.status === 200 && beyond.json.entries.length === 0 && beyond.json.next_cursor === ids.head, "a cursor past the head answers empty and points at the head");
  report.push(`feed resumes from a cursor across the restart: after=5 → [6,7]; pages of 2 walk 1..${ids.head}; past-the-head cursor → empty`);

  const view = await api("GET", `/v1/assertions/${ids.a1}`, p.alice);
  check(view.status === 200 && view.json.revocation?.superseded_by === ids.corr && view.json.resolved_id === ids.corr, "the correction chain survives the restart");
  const moderated = await api("GET", `/v1/assertions/${ids.a2}`, p.alice);
  check(moderated.json.revocation?.author.id === "owner", "the moderation survives the restart");
  const found = await api("GET", "/v1/search?q=sparse%20probes", p.alice);
  check(found.json.hits.some((h: any) => h.id === ids.corr) && !found.json.hits.some((h: any) => h.id === ids.a1), "search after restart: the correction, not the superseded claim");
  report.push("after restart: correction chain, moderation and search all read from the logs");

  const retry = await api("POST", "/v1/evidence", p.alice, { title: "Atlas kickoff notes", body: "The Atlas experiment should test sparse probes first, said Ada." });
  check(retry.status === 200 && retry.json.deduped === true && retry.json.id === ids.e1 && retry.json.seq === 1, `pre-restart retry must dedupe with its original seq: ${JSON.stringify(retry.json)}`);
  const retryAssert = await api("POST", "/v1/assertions", p.alice, { text: "[[Ada]] wants [[Atlas]] to test sparse probes first.", sources: [ids.e1] });
  check(retryAssert.status === 200 && retryAssert.json.id === ids.a1 && retryAssert.json.deduped === true, "a pre-restart assertion retried after the restart is recognised by id");
  const next = await api("POST", "/v1/evidence", p.alice, { title: "After the restart", body: "Ada confirmed the sparse-probe plan after the restart." });
  check(next.status === 201 && next.json.seq === ids.head + 1, `the sequence continues: ${JSON.stringify(next.json)}`);
  report.push(`pre-restart retries dedupe with their original seq; a new drop continues the sequence at ${next.json.seq}`);

  await session.crash();
  report.push(session.mode === "http" ? "SIGKILL the server (stale lock left behind), start a third — the lock is reclaimed" : "open another fresh handler");
  const afterCrash = await api("GET", `/v1/feed?after=${ids.head}`, p.owner);
  check(afterCrash.status === 200 && afterCrash.json.head === ids.head + 1 && afterCrash.json.entries[0]?.id === next.json.id, `feed after crash: ${JSON.stringify(afterCrash.json)}`);
  const more = await api("POST", "/v1/evidence", p.owner, { title: "After the crash", body: "The owner noted the plan again after the crash." });
  check(more.status === 201 && more.json.seq === ids.head + 2, `the sequence continues after the crash: ${JSON.stringify(more.json)}`);
  const inspect = sharedCli(["inspect", "--vault", p.root, "--members", p.store]).json;
  check(inspect.feed_head === ids.head + 2 && inspect.feed_missing.length === 0, `inspect after crash: ${JSON.stringify(inspect)}`);
  report.push(`after the crash: feed head ${afterCrash.json.head}, next write seq ${more.json.seq}, inspect reports nothing missing from the feed`);
  ids.head += 2;
  return report;
}

// ── phase 3: a second client ────────────────────────────────────────────────

export async function runClients(session: Session, p: Provisioned, ids: ScenarioIds): Promise<string[]> {
  const report: string[] = [];
  if (!session.alt) {
    report.push("SKIPPED — no socket in this run, so there is no second client (an in-process Request is not one)");
    return report;
  }
  const one = apiOver(session.fetcher);
  const two = apiOver(session.alt);

  const who = await two("GET", "/v1/whoami", p.owner);
  check(who.status === 200 && who.json.handle === "owner", `curl owner whoami: ${who.status} ${JSON.stringify(who.json)}`);
  check((await two("GET", "/v1/whoami", p.bob)).status === 401, "curl: revoked bob → 401");
  const read = await two("GET", `/v1/assertions/${ids.corr}`, p.alice);
  check(read.status === 200 && read.json.assertion.author.id === "alice" && read.json.assertion.supersedes === ids.a1, "curl reads what fetch wrote");
  report.push("curl (a second process per request): owner whoami 200, revoked bob 401, reads alice's correction written by the first client");

  const dropped = await two("POST", "/v1/evidence", p.alice, { title: "From the second client", body: "Ada's note arrived through curl this time." });
  check(dropped.status === 201 && dropped.json.seq === ids.head + 1, `curl write: ${dropped.status} ${JSON.stringify(dropped.json)}`);
  const seen = await one("GET", `/v1/feed?after=${ids.head}`, p.owner);
  check(seen.json.entries[0]?.id === dropped.json.id && seen.json.entries[0].actor.credential_id === p.aliceCredentialId, "the first client sees the second's write in the feed, attributed to alice's laptop credential");
  ids.head += 1;
  report.push(`curl writes evidence (seq ${dropped.json.seq}); fetch sees it in the feed with alice's credential id`);

  const caseInsensitive = await two("GET", "/v1/whoami", undefined, undefined, { Authorization: `BEARER ${p.alice}` });
  check(caseInsensitive.status === 200, "scheme is case-insensitive over the wire");
  const spaced = await two("GET", "/v1/whoami", undefined, undefined, { Authorization: `Bearer    ${p.alice}` });
  check(spaced.status === 200, "extra whitespace before the credential is tolerated");
  report.push("curl: `BEARER …` and `Bearer    …` verify; the credential itself is compared exactly");

  // Concurrent writes from BOTH clients at once: distinct items all land
  // with one contiguous run of sequence numbers; identical ones land once.
  const before = ids.head;
  const batch = await Promise.all([
    ...Array.from({ length: 12 }, (_, i) => one("POST", "/v1/assertions", p.alice, { text: `[[Ada]] noted concurrent item ${i} from the first client.`, sources: [ids.e1] })),
    ...Array.from({ length: 8 }, (_, i) => two("POST", "/v1/assertions", p.owner, { text: `[[Ada]] noted concurrent item ${i} from the second client.`, sources: [ids.e1] })),
  ]);
  check(batch.every((r) => r.status === 201), `every concurrent write is 201: ${batch.map((r) => r.status).join()}`);
  const seqs = batch.map((r) => r.json.seq as number).sort((a, b) => a - b);
  check(seqs.join() === Array.from({ length: 20 }, (_, i) => before + 1 + i).join(), `contiguous unique seqs ${before + 1}..${before + 20}, got ${seqs.join()}`);
  const same = await Promise.all([
    ...Array.from({ length: 4 }, () => one("POST", "/v1/evidence", p.alice, { title: "race", body: "the same evidence from two clients at once" })),
    ...Array.from({ length: 4 }, () => two("POST", "/v1/evidence", p.alice, { title: "race", body: "the same evidence from two clients at once" })),
  ]);
  check(same.filter((r) => r.status === 201).length === 1 && same.filter((r) => r.status === 200 && r.json.deduped).length === 7, `exactly one of 8 identical drops lands: ${same.map((r) => r.status).join()}`);
  check(new Set(same.map((r) => r.json.id)).size === 1 && new Set(same.map((r) => r.json.seq)).size === 1, "all 8 answer the same id and the same seq");
  ids.head = before + 21;
  const feed = await two("GET", `/v1/feed?after=${before}&limit=200`, p.owner);
  check(feed.json.head === ids.head && feed.json.entries.map((e: any) => e.seq).join() === Array.from({ length: 21 }, (_, i) => before + 1 + i).join(), `feed after the batch: ${feed.json.head}`);
  report.push(`20 concurrent assertions from both clients → seq ${before + 1}..${before + 20}, contiguous; 8 identical drops from both → one event, one seq`);
  return report;
}

// ── phase 4: adversarial authorization ──────────────────────────────────────

export async function runAdversarial(session: Session, p: Provisioned, ids: ScenarioIds): Promise<string[]> {
  const report: string[] = [];
  const api = apiOver(session.fetcher);
  const v = ["--vault", p.root, "--members", p.store];
  const headAt = async (): Promise<number> => (await api("GET", "/v1/feed?after=0&limit=1", p.owner)).json.head as number;
  const start = await headAt();
  check(start === ids.head, `head before the adversarial phase: ${start} vs ${ids.head}`);
  let legit = 0;

  // credentials that are not credentials
  const bad: [string, Record<string, string>, string][] = [
    ["wrong secret, real id", { Authorization: `Bearer ${p.alice.slice(0, -4)}AAAA` }, ""],
    ["unknown id", { Authorization: "Bearer sv_00000000_notarealsecretatall" }, ""],
    ["malformed", { Authorization: "Bearer hello" }, ""],
    ["empty bearer", { Authorization: "Bearer " }, ""],
    ["Basic scheme", { Authorization: `Basic ${Buffer.from(`alice:${p.alice}`).toString("base64")}` }, ""],
    ["credential in X-Api-Key", { "X-Api-Key": p.alice }, ""],
    ["credential in the query", {}, `?access_token=${p.alice}`],
    ["credential in a cookie", { Cookie: `token=${p.alice}` }, ""],
  ];
  for (const [what, headers, query] of bad) {
    const r = await api("GET", `/v1/whoami${query}`, undefined, undefined, headers);
    check(r.status === 401 && r.headers.get("www-authenticate") === "Bearer", `${what} → 401, got ${r.status}`);
    const w = await api("POST", `/v1/evidence${query}`, undefined, { title: "x", body: "y" }, headers);
    check(w.status === 401, `${what} write → 401, got ${w.status}`);
  }
  report.push(`${bad.length} non-credentials (wrong secret, unknown id, malformed, empty, Basic, header, query, cookie) → 401 on read and write`);

  // a revoked CREDENTIAL, the member and her other credentials standing
  const tablet = sharedCli(["credential", "mint", "alice", ...v, "--name", "tablet"]).json;
  check((await api("GET", "/v1/whoami", tablet.token)).status === 200, "the new credential verifies");
  sharedCli(["credential", "revoke", tablet.credential.id, ...v]);
  check((await api("GET", "/v1/whoami", tablet.token)).status === 401, "the revoked credential → 401");
  check((await api("POST", "/v1/evidence", tablet.token, { title: "x", body: "y" })).status === 401, "the revoked credential cannot write");
  check((await api("GET", "/v1/whoami", p.alice)).status === 200, "alice's laptop still verifies");
  report.push("a second credential of alice's minted, then revoked by the CLI → 401 immediately; her laptop still verifies");

  // read-only member, read-scoped credential
  check((await api("GET", "/v1/feed", p.carol)).status === 200, "carol reads");
  for (const [method, path, body] of [
    ["POST", "/v1/evidence", { title: "x", body: "y" }],
    ["POST", "/v1/assertions", { text: "[[Ada]] said something long enough.", sources: [ids.e1] }],
    ["POST", `/v1/assertions/${ids.corr}/correct`, { text: "[[Ada]] said something long enough.", sources: [ids.e1] }],
    ["POST", `/v1/assertions/${ids.corr}/retract`, { reason: "x" }],
    ["POST", "/v1/moderation", { assertion_id: ids.corr, reason: "x" }],
  ] as const) {
    const r = await api(method, path, p.carol, body);
    check(r.status === 403 && /missing permission write/u.test(r.json.error), `carol ${path} → 403 missing write, got ${r.status} ${JSON.stringify(r.json)}`);
    const s = await api(method, path, p.aliceReadOnly, body);
    check(s.status === 403, `alice's read-scoped credential ${path} → 403, got ${s.status}`);
  }
  report.push("read-only member carol and alice's read-scoped credential: every write route → 403 naming the missing permission");

  // narrowing a member narrows every credential immediately
  sharedCli(["member", "set", "alice", ...v, "--permissions", "read"]);
  const narrowed = await api("GET", "/v1/whoami", p.alice);
  check(narrowed.status === 200 && narrowed.json.permissions.join() === "read", "alice narrowed to read");
  check((await api("POST", "/v1/evidence", p.alice, { title: "x", body: "y" })).status === 403, "narrowed alice cannot write");
  sharedCli(["member", "set", "alice", ...v, "--permissions", "read,write"]);
  const restored = await api("POST", "/v1/evidence", p.alice, { title: "Restored", body: "Ada's write after her permission was restored." });
  check(restored.status === 201, "restored alice writes again");
  legit += 1;
  report.push("member set alice → read: her laptop credential is read-only on its next request; set back → she writes again");

  // forged authorship, in the body and in the origin
  for (const body of [
    { title: "x", body: "y", author: { kind: "user", id: "owner" } },
    { title: "x", body: "y", actor: "owner" },
    { title: "x", body: "y", on_behalf_of: "owner" },
    { title: "x", body: "y", id: "ins_000000000000000000000000" },
    { title: "x", body: "y", created_at: "2020-01-01T00:00:00Z" },
    { title: "x", body: "y", seq: 1 },
    { title: "x", body: "y", origin: { author: "grace", submitted_by: "owner" } },
    { title: "x", body: "y", origin: { author: "grace", author_verified: true } },
    { title: "x", body: "y", envelope: { submitted_by: "owner" } },
  ]) {
    const r = await api("POST", "/v1/evidence", p.alice, body);
    check(r.status === 400 && /forged authorship/u.test(r.json.error), `forged ${JSON.stringify(body)} → 400, got ${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const body of [
    { text: "[[Ada]] said something long enough.", sources: [ids.e1], author: { kind: "user", id: "owner" } },
    { text: "[[Ada]] said something long enough.", sources: [ids.e1], supersedes: ids.a1 },
    { text: "[[Ada]] said something long enough.", sources: [ids.e1], produced_by: { procedure: "gardener" } },
  ]) {
    const r = await api("POST", "/v1/assertions", p.alice, body);
    check(r.status === 400 && /forged authorship/u.test(r.json.error), `forged assertion ${JSON.stringify(body)} → 400`);
  }
  const unknownField = await api("POST", "/v1/evidence", p.alice, { title: "x", body: "y", tags: ["a"] });
  check(unknownField.status === 400 && /unknown evidence field/u.test(unknownField.json.error), "unknown fields are refused, not dropped");
  report.push("12 forged-authorship bodies (author, actor, on_behalf_of, id, created_at, seq, origin.submitted_by, origin.author_verified, envelope, supersedes, produced_by) → 400; unknown fields → 400");

  // the owner is not the author: moderation is the owner's tool, not correction
  check((await api("POST", `/v1/assertions/${ids.corr}/correct`, p.owner, { text: "[[Ada]] wants something else entirely.", sources: [ids.e1] })).status === 403, "owner cannot correct alice's");
  check((await api("POST", `/v1/assertions/${ids.corr}/retract`, p.owner, { reason: "x" })).status === 403, "owner cannot retract alice's");
  check((await api("POST", "/v1/moderation", p.alice, { assertion_id: ids.corr, reason: "x" })).status === 403, "alice cannot moderate");
  check((await api("POST", `/v1/assertions/${ids.a1}/correct`, p.alice, { text: "[[Ada]] wants something else entirely.", sources: [ids.e1] })).status === 409, "a superseded assertion cannot be corrected again");
  check((await api("POST", "/v1/moderation", p.owner, { assertion_id: ids.a2, reason: "again" })).status === 409, "a moderated assertion cannot be moderated again");
  report.push("owner correct/retract of alice's → 403; alice moderation → 403; re-correcting or re-moderating a revoked assertion → 409");

  // ids that are not ids never become paths
  for (const path of [
    "/v1/evidence/..%2F..%2Fmembers.json",
    "/v1/evidence/%2Fetc%2Fpasswd",
    "/v1/evidence/ins_..%2F..%2F..%2Fvault.yaml",
    "/v1/assertions/..%2F..%2F..%2Fmembers.json",
    `/v1/assertions/${encodeURIComponent("../log/insertions")}`,
    "/v1/assertions/ast_%00",
  ]) {
    const r = await api("GET", path, p.alice);
    check(r.status === 400, `${path} → 400, got ${r.status}`);
  }
  check((await api("POST", "/v1/assertions/..%2F..%2Fx/correct", p.alice, { text: "[[Ada]] said something long enough.", sources: [ids.e1] })).status === 400, "traversal in a correct path → 400");
  check((await api("POST", "/v1/moderation", p.owner, { assertion_id: "../../members.json", reason: "x" })).status === 400, "traversal in a moderation body → 400");
  check((await api("POST", "/v1/assertions", p.alice, { text: "[[Ada]] said something long enough.", sources: ["../../members.json"] })).status === 400, "traversal in a citation → 400");
  report.push("9 traversal / absolute / NUL ids across evidence, assertions, correct, moderation and citations → 400 before any path is formed");

  // the surface is the table
  check((await api("GET", "/v1/unknown-admin", undefined)).status === 401, "unknown route without a credential → 401");
  check((await api("GET", "/v1/unknown-admin", p.alice)).status === 404, "unknown route with a credential → 404");
  check((await api("GET", "/members.json", p.alice)).status === 404, "the store is not a route");
  check((await api("GET", "/", undefined)).status === 401, "the root is not a route");
  check((await api("DELETE", `/v1/assertions/${ids.corr}`, p.owner)).status === 404, "DELETE is not a method here");
  check((await api("PUT", "/v1/evidence", p.alice, { title: "x", body: "y" })).status === 404, "PUT is not a method here");
  check((await api("GET", "/v1/evidence/", p.alice)).status === 404, "a trailing slash is not a route");
  report.push("unknown routes → 401 without a credential, 404 with one; DELETE/PUT → 404; the member store is not reachable");

  // bodies that are not bodies
  const text = await api("POST", "/v1/evidence", p.alice, undefined, { "Content-Type": "text/plain" });
  check(text.status === 415, `text/plain → 415, got ${text.status}`);
  const badJson = await api("POST", "/v1/evidence", p.alice, "{not json");
  check(badJson.status === 400, "bad JSON → 400");
  for (const notObject of ["[]", '"x"', "42", "null"]) check((await api("POST", "/v1/evidence", p.alice, notObject)).status === 400, `${notObject} → 400`);
  // Over a socket the server may answer 413 or cut the upload short
  // (Bun's maxRequestBodySize); either way nothing lands — the head check
  // at the end of this phase is the proof.
  let hugeOutcome: string;
  try {
    const huge = await api("POST", "/v1/evidence", p.alice, { title: "huge", body: "x".repeat(MAX_SHARED_REQUEST_BYTES + 1024) });
    check(huge.status === 413, `oversize body → 413, got ${huge.status}`);
    hugeOutcome = "413";
  } catch (error) {
    if (session.mode !== "http") throw error;
    hugeOutcome = `the server cut the upload (${error instanceof Error ? error.message : error})`;
  }
  report.push(`text/plain → 415; malformed JSON and non-object JSON → 400; a ${Math.round((MAX_SHARED_REQUEST_BYTES + 1024) / 1024)} KiB body → ${hugeOutcome}`);

  // feed and list parameters
  for (const q of ["after=-1", "after=1e3", "after=0x10", "after=1.0", "limit=0", "limit=201", "limit=abc"]) {
    const r = await api("GET", `/v1/feed?${q}`, p.alice);
    check(r.status === 400, `/v1/feed?${q} → 400, got ${r.status}`);
  }
  check((await api("GET", "/v1/evidence?limit=201", p.alice)).status === 400, "list limit over the cap → 400");
  check((await api("GET", "/v1/search?q=", p.alice)).status === 400, "empty search → 400");
  report.push("bad feed cursors and limits (negative, exponent, hex, float, zero, over cap, non-numeric) → 400");

  // the write rate limit, on a credential of its own
  const burst = sharedCli(["credential", "mint", "alice", ...v, "--name", "burst"]).json;
  const spent = await Promise.all(Array.from({ length: 60 }, (_, i) => api("POST", "/v1/evidence", burst.token, { title: `burst ${i}`, body: `burst body ${i}` })));
  check(spent.every((r) => r.status === 201), `60 writes in a minute all land: ${spent.map((r) => r.status).join()}`);
  const limited = await api("POST", "/v1/evidence", burst.token, { title: "burst 60", body: "one too many" });
  check(limited.status === 429 && Number(limited.headers.get("retry-after")) >= 1, `the 61st → 429 with Retry-After, got ${limited.status}`);
  check((await api("POST", "/v1/evidence", p.alice, { title: "Not limited", body: "Ada's laptop is a different bucket." })).status === 201, "another credential is not rate-limited by it");
  check((await api("GET", "/v1/feed", burst.token)).status === 200, "reads are not rate-limited");
  legit += 61;
  report.push("write rate limit: 60 writes on one credential land, the 61st → 429 Retry-After; another credential and reads are unaffected");

  // a revocation that lands WHILE a body is uploading refuses that upload
  const slow = sharedCli(["credential", "mint", "alice", ...v, "--name", "slow"]).json;
  let revokedMidUpload = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!revokedMidUpload) {
        controller.enqueue(new TextEncoder().encode('{"title":"mid-upload","body":"'));
        sharedCli(["credential", "revoke", slow.credential.id, ...v]);
        revokedMidUpload = true;
        await new Promise((r) => setTimeout(r, 20));
      } else {
        controller.enqueue(new TextEncoder().encode('the body that arrived after the revocation"}'));
        controller.close();
      }
    },
  });
  let mid: Response | undefined;
  try {
    mid = await session.fetcher("/v1/evidence", {
      method: "POST",
      headers: { Authorization: `Bearer ${slow.token}`, "Content-Type": "application/json" },
      body: stream,
      // @ts-expect-error — the streaming-body flag, not in lib.dom's RequestInit yet
      duplex: "half",
    });
  } catch (error) {
    report.push(`revocation mid-upload: SKIPPED — this transport could not stream a request body (${error instanceof Error ? error.message : error})`);
  }
  if (mid) {
    check(mid.status === 401, `a body that finished uploading after its credential was revoked → 401, got ${mid.status}`);
    report.push("a credential revoked while its request body was still uploading → that request is 401 and nothing landed");
  }

  const end = await headAt();
  check(end === start + legit, `feed head moved only by the ${legit} legitimate writes: ${start} → ${end}`);
  ids.head = end;
  const inspect = sharedCli(["inspect", ...v]).json;
  check(inspect.feed_head === end && inspect.feed_missing.length === 0, `inspect: ${JSON.stringify(inspect)}`);
  report.push(`feed head ${start} → ${end}: exactly the ${legit} legitimate writes, nothing refused landed; inspect reports nothing missing`);
  return report;
}

// ── running a real server ───────────────────────────────────────────────────

export interface Spawned {
  url: string;
  port: number;
  pid: number;
  /** SIGTERM and wait. */
  stop: () => Promise<void>;
  /** SIGKILL and wait — no cleanup, the lock stays behind. */
  kill: () => Promise<void>;
  /** Everything the server printed so far (stdout lines: the listening
   * line, then one JSON line per request). */
  log: () => string[];
}

/** Real HTTP: spawn the entrypoint on 127.0.0.1:0, wait for its
 * "listening" line, keep draining stdout (a full pipe would block the
 * server), hand back the URL. */
export async function spawnServer(root: string, store: string): Promise<Spawned> {
  const child = Bun.spawn([process.execPath, SHARED_BIN, "serve", "--vault", root, "--members", store, "--host", "127.0.0.1", "--port", "0"], {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  const lines: string[] = [];
  let partial = "";
  let listening: ((info: { port: number }) => void) | undefined;
  let failed: ((reason: Error) => void) | undefined;
  const ready = new Promise<{ port: number }>((res, rej) => {
    listening = res;
    failed = rej;
  });
  const drain = (async (): Promise<void> => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      partial += decoder.decode(value, { stream: true });
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        if (line.includes('"shared":"listening"')) listening?.(JSON.parse(line) as { port: number });
      }
    }
    if (partial) lines.push(partial);
  })();
  void child.exited.then(async () => {
    await drain;
    failed?.(new Error(`bin/shared.ts serve exited ${child.exitCode}: ${lines.join("\n")} ${await new Response(child.stderr).text()}`));
  });
  const timer = setTimeout(() => failed?.(new Error(`bin/shared.ts serve did not report listening within 15s: ${lines.join("\n")}`)), 15_000);
  let info: { port: number };
  try {
    info = await ready;
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    url: `http://127.0.0.1:${info.port}`,
    port: info.port,
    pid: child.pid,
    stop: async () => {
      child.kill("SIGTERM");
      await child.exited;
      await drain;
    },
    kill: async () => {
      child.kill("SIGKILL");
      await child.exited;
      await drain;
    },
    log: () => [...lines],
  };
}

/** A fetcher that is a different HTTP client entirely: `curl`, one process
 * per request. The Response it returns carries the status, the body and
 * the headers curl saw. */
export function curlFetcher(url: () => string): Fetcher {
  return async (path, init = {}) => {
    // `Expect:` empty: no 100-continue dance on bodies over 1 KiB.
    const args = ["curl", "-sS", "--max-time", "30", "-X", init.method ?? "GET", "-D", "-", "-o", "-", "-H", "Expect:"];
    const headers = new Headers(init.headers ?? {});
    headers.forEach((value, name) => args.push("-H", `${name}: ${value}`));
    let stdin: "ignore" | Buffer = "ignore";
    if (init.body !== undefined) {
      if (typeof init.body !== "string" && !(init.body instanceof Uint8Array)) throw new Error("curlFetcher: only string or bytes bodies");
      args.push("--data-binary", "@-");
      stdin = Buffer.from(init.body as string | Uint8Array);
    }
    args.push(`${url()}${path}`);
    const r = Bun.spawnSync(args, { stdin, stdout: "pipe", stderr: "pipe", env: childEnv() });
    if (r.exitCode !== 0) throw new Error(`curl exited ${r.exitCode}: ${r.stderr.toString()}`);
    return parseCurlOutput(r.stdout.toString("utf8"));
  };
}

/** `curl -D - -o -` output: header block(s), a blank line, the body. An
 * interim `1xx` block, if any, precedes the final one; the LAST block's
 * status is the answer. */
export function parseCurlOutput(raw: string): Response {
  let rest = raw;
  let head = "";
  for (;;) {
    const split = rest.indexOf("\r\n\r\n");
    if (split === -1) throw new Error(`curl: no header block in ${JSON.stringify(raw.slice(0, 200))}`);
    head = rest.slice(0, split);
    rest = rest.slice(split + 4);
    if (!/^HTTP\/[\d.]+ 1\d\d/u.test(head)) break;
  }
  const [statusLine, ...headerLines] = head.split("\r\n");
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/u.exec(statusLine ?? "")?.[1]);
  if (!status) throw new Error(`curl: no status line in ${JSON.stringify(head)}`);
  const out = new Headers();
  for (const line of headerLines) {
    const i = line.indexOf(":");
    if (i > 0) out.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return new Response(rest, { status, headers: out });
}

/** The whole run — every phase — over a session. Prints as it goes. */
export async function runAll(session: Session, p: Provisioned): Promise<{ phases: Record<string, string[]>; ids: ScenarioIds }> {
  const revoke = (): void => {
    sharedCli(["member", "revoke", "bob", "--vault", p.root, "--members", p.store]);
  };
  const phases: Record<string, string[]> = {};
  const print = (name: string, report: string[]): void => {
    console.log(`\n[${name}]`);
    for (const line of report) console.log(`  ${line.startsWith("SKIPPED") ? "–" : "✓"} ${line}`);
    phases[name] = report;
  };
  const scenario = await runScenario(session.fetcher, p, revoke);
  print("scenario", scenario.report);
  print("persistence", await runPersistence(session, p, scenario.ids));
  print("clients", await runClients(session, p, scenario.ids));
  print("adversarial", await runAdversarial(session, p, scenario.ids));
  return { phases, ids: scenario.ids };
}

/** A session over the in-process handler: no socket, restart = a fresh
 * handler over the directory, no second client. */
export function handlerSession(p: Provisioned): Session {
  let handler = makeSharedApiHandler({ root: p.root, storePath: p.store, log: () => {} });
  const reopen = async (): Promise<void> => {
    handler = makeSharedApiHandler({ root: p.root, storePath: p.store, log: () => {} });
  };
  return {
    mode: "handler",
    fetcher: (path, init) => handler(new Request(`http://shared.local${path}`, init)),
    restart: reopen,
    crash: reopen,
  };
}

/** A session over `bin/shared.ts serve` on 127.0.0.1:0, restarted and
 * crashed for real; `curl` as the second client. */
export async function httpSession(p: Provisioned): Promise<Session & { current: () => Spawned; close: () => Promise<void> }> {
  let server = await spawnServer(p.root, p.store);
  const url = (): string => server.url;
  return {
    mode: "http",
    fetcher: (path, init) => fetch(`${url()}${path}`, init),
    alt: curlFetcher(url),
    restart: async () => {
      await server.stop();
      if (existsSync(join(p.root, ".state", "shared-server.lock"))) throw new Error("smoke: SIGTERM did not release the lock");
      server = await spawnServer(p.root, p.store);
    },
    crash: async () => {
      await server.kill();
      if (!existsSync(join(p.root, ".state", "shared-server.lock"))) throw new Error("smoke: SIGKILL should have left the lock behind");
      server = await spawnServer(p.root, p.store);
    },
    current: () => server,
    close: () => server.stop(),
  };
}

if (import.meta.main) {
  const url = flagValue(process.argv, "url");
  const dir = flagValue(process.argv, "dir");
  if (url) {
    const tokens = { owner: flagValue(process.argv, "owner") ?? "", alice: flagValue(process.argv, "alice") ?? "", bob: flagValue(process.argv, "bob") ?? "" };
    if (!tokens.owner || !tokens.alice || !tokens.bob) throw new Error("--url mode needs --owner, --alice and --bob credentials (fresh members; bob is revoked by this run)");
    const store = flagValue(process.argv, "members");
    const rootFlag = flagValue(process.argv, "vault");
    if (!store || !rootFlag) throw new Error("--url mode needs --vault and --members so the run can revoke bob through the CLI");
    console.log(`shared-vault smoke (scenario phase) over real HTTP at ${url}`);
    for (const line of await runSmoke((p, init) => fetch(`${url}${p}`, init), tokens, () => sharedCli(["member", "revoke", "bob", "--vault", rootFlag, "--members", store]))) console.log(`  ✓ ${line}`);
  } else if (dir) {
    const p = provision(resolve(dir));
    if (hasFlag(process.argv, "http")) {
      const session = await httpSession(p);
      console.log(`shared-vault smoke over REAL HTTP: bin/shared.ts serve (pid ${session.current().pid}) at ${session.current().url}, curl as the second client`);
      try {
        await runAll(session, p);
      } finally {
        await session.close();
      }
    } else {
      console.log(`shared-vault smoke through the IN-PROCESS handler (no socket) over ${p.root}`);
      await runAll(handlerSession(p), p);
    }
    console.log(`\n${sharedCli(["inspect", "--vault", p.root, "--members", p.store]).out.trim()}`);
  } else {
    console.error("usage: bun test/support/sharedVaultSmoke.ts --dir <scratch> [--http] | --url <server> --vault <dir> --members <file> --owner <sv_…> --alice <sv_…> --bob <sv_…>");
    process.exit(2);
  }
}
