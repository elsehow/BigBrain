/**
 * The shared vault's ENTRYPOINT — `bin/shared.ts` as a subprocess: the
 * provisioning CLI, the refusals that keep it explicit, and the serve loop
 * over a real loopback socket when the environment allows one.
 *
 * Two tiers, kept distinct on purpose:
 *   - subprocess CLI + in-process handler: always runs — every phase of
 *     test/support/sharedVaultSmoke.ts except the second-client one, which
 *     is reported SKIPPED there (an in-process Request is not a client);
 *   - real HTTP (`serve` on 127.0.0.1:0, `fetch` and `curl` from here,
 *     SIGTERM restart, SIGKILL crash): runs only when this process can
 *     bind a loopback port. A sandbox that refuses `bind` SKIPS it loudly
 *     (see `canBind` below) — a skipped socket test is not a passed one,
 *     and the run's summary says so.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedServerLock } from "../lib/sharedVault";
import { isHeld } from "../lib/sqliteLock";
import { handlerSession, httpSession, parseCurlOutput, provision, runAll, sharedCli } from "./support/sharedVaultSmoke";

const scratch = (): string => mkdtempSync(join(tmpdir(), "bb-shared-server-"));

/** Can this process listen on loopback at all? */
function canBind(): { ok: true } | { ok: false; reason: string } {
  try {
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
    s.stop(true);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
const bind = canBind();
if (!bind.ok) console.warn(`sharedVaultServer: SKIPPING real-socket tests — this environment refuses to listen on 127.0.0.1 (${bind.reason})`);

describe("bin/shared.ts — the CLI", () => {
  test("init, member add, credential mint, list, inspect — through the real entrypoint", () => {
    const dir = scratch();
    const root = join(dir, "v");
    const store = join(dir, "m.json");
    const init = sharedCli(["init", "--vault", root, "--members", store, "--owner", "owner"]).json;
    expect(init.member).toMatchObject({ handle: "owner", role: "owner" });
    expect(init.token).toMatch(/^sv_[0-9a-f]{8}_/u);
    expect(existsSync(join(root, "vault.yaml"))).toBe(true);
    expect(existsSync(join(root, "log", "shared-feed"))).toBe(true);
    // a second init refuses to clobber
    const again = sharedCli(["init", "--vault", root, "--members", store, "--owner", "owner2"], { expectFail: true });
    expect(again.code).toBe(1);
    expect(again.err).toContain("already exists");
    expect(sharedCli(["member", "add", "alice", "--vault", root, "--members", store, "--permissions", "read"]).json).toMatchObject({ handle: "alice", permissions: ["read"] });
    // scope escalation at mint time is refused by the CLI too
    const escalate = sharedCli(["credential", "mint", "alice", "--vault", root, "--members", store, "--name", "x", "--scopes", "write"], { expectFail: true });
    expect(escalate.code).toBe(1);
    expect(escalate.err).toContain("cannot exceed");
    expect(sharedCli(["member", "set", "alice", "--vault", root, "--members", store, "--permissions", "read,write"]).json.permissions).toEqual(["read", "write"]);
    const minted = sharedCli(["credential", "mint", "alice", "--vault", root, "--members", store, "--name", "laptop", "--kind", "agent"]).json;
    expect(minted.credential).toMatchObject({ name: "laptop", kind: "agent", scopes: ["read", "write"] });
    const list = sharedCli(["credential", "list", "alice", "--vault", root, "--members", store]).json;
    expect(list).toHaveLength(1);
    expect(list[0].sha256).toBeString();
    expect(JSON.stringify(list)).not.toContain(minted.token);
    expect(sharedCli(["member", "list", "--vault", root, "--members", store]).json.map((m: any) => m.handle)).toEqual(["owner", "alice"]);
    expect(sharedCli(["inspect", "--vault", root, "--members", store]).json).toMatchObject({ feed_head: 0, evidence: 0, assertions: 0 });
    expect(sharedCli(["member", "revoke", "alice", "--vault", root, "--members", store]).json.revoked).toBeString();
    expect(sharedCli(["member", "revoke", "owner", "--vault", root, "--members", store], { expectFail: true }).err).toContain("cannot be revoked");
    // the installed command reaches the same program
    expect(sharedCli(["member", "list", "--vault", root, "--members", store], { via: "cli" }).json.map((m: any) => m.handle)).toEqual(["owner", "alice"]);
  }, 60_000);

  test("the shared vault is never discovered, never a personal vault, never off loopback without --remote, and never keeps its store inside", () => {
    const dir = scratch();
    const r = sharedCli(["member", "list", "--members", join(dir, "m.json")], { expectFail: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("never discovered");
    const serve = sharedCli(["serve", "--vault", join(dir, "nope"), "--members", join(dir, "m.json")], { expectFail: true });
    expect(serve.code).toBe(1);
    expect(serve.err).toContain("not a shared vault");
    // a personal vault has a vault.yaml too — without `shared: true` the door refuses it
    const personal = join(dir, "personal");
    mkdirSync(personal);
    writeFileSync(join(personal, "vault.yaml"), "integrations: {}\n");
    const notShared = sharedCli(["serve", "--vault", personal, "--members", join(dir, "m.json")], { expectFail: true });
    expect(notShared.code).toBe(1);
    expect(notShared.err).toContain("shared: true");
    expect(sharedCli(["inspect", "--vault", personal, "--members", join(dir, "m.json")], { expectFail: true }).err).toContain("shared: true");
    // the member store must live outside the vault
    const p = provision(join(dir, "p"));
    const insideStore = sharedCli(["member", "list", "--vault", p.root, "--members", join(p.root, "members.json")], { expectFail: true });
    expect(insideStore.code).toBe(1);
    expect(insideStore.err).toContain("outside the vault");
    // off-loopback needs --remote, and says why
    const remote = sharedCli(["serve", "--vault", p.root, "--members", p.store, "--host", "0.0.0.0", "--port", "0"], { expectFail: true });
    expect(remote.code).toBe(1);
    expect(remote.err).toContain("--remote");
    expect(remote.err).toContain("TLS");
  }, 60_000);

  test("every phase through the in-process handler: scenario, restart persistence, adversarial authorization; the second-client phase is SKIPPED, not passed", async () => {
    const dir = scratch();
    const p = provision(dir);
    const storeBefore = readFileSync(p.store, "utf8");
    const { phases, ids } = await runAll(handlerSession(p), p);
    expect(phases["scenario"]!.length).toBeGreaterThan(15);
    expect(phases["persistence"]!.length).toBeGreaterThan(5);
    expect(phases["clients"]).toEqual([expect.stringMatching(/^SKIPPED/u)]);
    expect(phases["adversarial"]!.length).toBeGreaterThan(10);
    expect(sharedCli(["inspect", "--vault", p.root, "--members", p.store]).json).toMatchObject({ feed_head: ids.head, assertions: 3, live_assertions: 1, revoked_assertions: 2, feed_missing: [] });
    // the handler wrote only logs; the store stayed outside the vault, and
    // the door never wrote the store — every byte of it is the CLI's
    expect(readdirSync(p.root).sort()).toEqual([".shared-identity.json", ".spool", "log", "vault.yaml"]);
    expect(readdirSync(join(p.root, "log")).sort()).toEqual(["assertions", "insertions", "revocations", "shared-feed"]);
    const storeAfter = readFileSync(p.store, "utf8");
    expect(storeAfter).not.toBe(storeBefore); // the CLI revoked and minted during the run…
    expect(JSON.parse(storeAfter).credentials.every((c: any) => c.last_used === null)).toBe(true); // …but usage never went into it
    expect(existsSync(`${p.store}.usage.json`)).toBe(true);
  }, 60_000);
});

describe("the second client's plumbing", () => {
  test("curl -D - -o - output parses to status, headers and body, past an interim 1xx block", async () => {
    const one = parseCurlOutput('HTTP/1.1 201 Created\r\nContent-Type: application/json; charset=utf-8\r\nRetry-After: 3\r\n\r\n{"seq":4}\n');
    expect(one.status).toBe(201);
    expect(one.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(one.headers.get("retry-after")).toBe("3");
    expect(await one.json()).toEqual({ seq: 4 });
    const interim = parseCurlOutput('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n{"error":"unauthorized"}\n');
    expect(interim.status).toBe(401);
    expect(interim.headers.get("www-authenticate")).toBe("Bearer");
    expect(() => parseCurlOutput("garbage")).toThrow(/no header block/u);
  });
});

describe("bin/shared.ts serve — the real socket", () => {
  // Runs everywhere, so a listen-capable run reports ZERO skips: where the
  // environment refuses bind, port 0 is refused outright; where it allows
  // one, this process occupies an ephemeral port first and `serve` must
  // fail on THAT port the same way — non-zero, a clear message, no lock.
  test("when the socket cannot be bound (refused, or the port is taken), serve exits non-zero with a clear message and releases its lock", () => {
    const dir = scratch();
    const p = provision(dir);
    const occupied = bind.ok ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") }) : null;
    try {
      const port = occupied ? occupied.port : 0;
      const r = sharedCli(["serve", "--vault", p.root, "--members", p.store, "--port", String(port)], { expectFail: true });
      expect(r.code).toBe(1);
      expect(r.err).toContain(`cannot listen on 127.0.0.1:${port}`);
      if (!bind.ok) expect(r.err).toContain("refused"); // names the likely cause instead of Bun's "is port 0 in use?"
      expect(isHeld(sharedServerLock(p.root))).toBe(false);
    } finally {
      occupied?.stop(true);
    }
  });

  test.skipIf(!bind.ok)("serve on 127.0.0.1:0: every phase over HTTP with fetch and curl, SIGTERM restart, SIGKILL crash; a second serve is refused by the lock", async () => {
    const dir = scratch();
    const p = provision(dir);
    const session = await httpSession(p);
    try {
      expect(session.current().port).toBeGreaterThan(0);
      // the vault's lock single-flights the server, and says which process has it
      const second = sharedCli(["serve", "--vault", p.root, "--members", p.store, "--port", "0"], { expectFail: true });
      expect(second.code).toBe(1);
      expect(second.err).toContain(`another server holds ${sharedServerLock(p.root)}`);
      expect(second.out).toContain(`shared: another run holds the lock (pid ${session.current().pid}); exiting`);
      // transport-level: no CORS, no caching, JSON only
      const res = await fetch(`${session.current().url}/v1/whoami`, { headers: { Authorization: `Bearer ${p.alice}` } });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const { phases, ids } = await runAll(session, p);
      expect(phases["clients"]!.length).toBeGreaterThan(3);
      expect(phases["clients"]!.some((l) => l.startsWith("SKIPPED"))).toBe(false);
      expect(sharedCli(["inspect", "--vault", p.root, "--members", p.store]).json).toMatchObject({ feed_head: ids.head, feed_missing: [] });
      // the server logged every request as one JSON line, never a secret
      const log = session.current().log();
      expect(log.some((l) => l.includes('"status":401'))).toBe(true);
      expect(log.join("\n")).not.toContain(p.alice.slice(12));
    } finally {
      await session.close();
    }
    expect(isHeld(sharedServerLock(p.root))).toBe(false);
  }, 120_000);
});
