/**
 * The web server's request backstop, RUN — a real subprocess on a real
 * socket, because the behavior under test is process survival and no
 * in-process harness can honestly fake an uncaughtException.
 *
 * The hazard: the assertion gates read their logs TOLERANTLY (damage is
 * skipped), but the surfaces behind them read STRICTLY — /api/recent's
 * assertion branch strict-reads the insertion log. A HALF-ported vault —
 * one valid assertion plus one damaged event file — passes the gate and
 * then throws inside the route, and before the backstop that throw reached
 * node:http as an uncaughtException and killed the server: under systemd's
 * Restart=always, a crash loop fed by every page load. An untouched legacy
 * vault can never hit this (the gate finds nothing and the strict readers
 * are never called); only a port-in-progress can.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAssertionEvent } from "../lib/assertionLog";
import { viewerAuth, viewerHome, viewerSecret } from "./support/viewerSession";

const SERVER = join(import.meta.dir, "..", "web", "server.ts");

/** A half-ported vault: the gate answers "assertions", the strict read throws. */
function halfPortedVault(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-guard-"));
  writeFileSync(join(root, "vault.yaml"), "");
  mkdirSync(join(root, "references"), { recursive: true });
  appendAssertionEvent(root, {
    event: "assertion.asserted",
    id: `ast_${"a".repeat(24)}`,
    text: "One settled assertion keeps the gate open.",
    entities: [],
    sources: [{ insertion_id: `ins_${"b".repeat(24)}`, source_id: "src-1" }],
    author: { kind: "user", id: "tester" },
    confidence: "direct",
    created_at: "2026-08-20T00:00:00Z",
    produced_by: { procedure: "test-fixture", version: "1" },
  });
  const month = join(root, "log", "insertions", "2026-08");
  mkdirSync(month, { recursive: true });
  writeFileSync(join(month, `ins_${"c".repeat(24)}.json`), "{broken");
  return root;
}

let proc: ReturnType<typeof Bun.spawn> | undefined;
afterAll(() => proc?.kill());

describe("web/server.ts request backstop", () => {
  test("a route throw costs the request a 500, never the process", async () => {
    // An ephemeral port, found by briefly binding one.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);

    const home = viewerHome();
    proc = Bun.spawn(["bun", SERVER], {
      env: { ...process.env, HOME: home, BIGBRAIN_VAULT: halfPortedVault(), PORT: String(port) },
      stdout: "ignore",
      stderr: "pipe",
    });
    const log = new Response(proc.stderr as ReadableStream).text();
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    // Up when the socket answers anything at all.
    for (;;) {
      try {
        await fetch(`${origin}/`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("server never came up");
        await Bun.sleep(100);
      }
    }

    // A query can carry a bootstrap secret: nothing the server says repeats it.
    const secret = viewerSecret(home, port)!;
    const recent = await fetch(`${origin}/api/recent?k=${secret}`, { headers: viewerAuth(home, port) });
    expect(recent.status).toBe(500);
    // The body names the actual damage, same posture as /api/graph's catch.
    expect(((await recent.json()) as { error: string }).error).toContain("unreadable event");

    // The server is still alive to answer the next request.
    const alive = await fetch(`${origin}/`, { headers: viewerAuth(home, port) });
    expect(alive.status).toBe(200);
    proc.kill();
    expect(await log).not.toContain(secret);
  }, 20_000);
});
