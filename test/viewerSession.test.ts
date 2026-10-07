/**
 * The viewer's per-launch session (lib/viewerSession.ts): every route of
 * web/server.ts and of the first-run door refuses a request without it, and
 * the secret stays out of argv, the children's environment and the logs.
 *
 * The route lists are read from the tables (web/server.ts ROUTES, the door's
 * route builders), so a route added there is covered here without an edit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { allowLoopbackRequest, armor, json, THEME_SHEET, type Route } from "../lib/httpx";
import { newViewerSecret, SESSION_PATH, viewerGate, viewerLink } from "../lib/viewerSession";
import { feedbackRoutes } from "../lib/feedback";
import { setupRoutes, setupState } from "../lib/firstRun";
import { ENGINE_ROOT } from "../lib/engine";
import { ROUTES } from "../web/server";
import { nativeVault, NATIVE_YAML } from "./support/vault";
import { viewerAuth, viewerHome, viewerSecret } from "./support/viewerSession";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratchHome = (): string => {
  const home = viewerHome();
  dirs.push(home);
  return home;
};

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

/** One request. Resolves at the response head for a stream that never ends
 * (SSE), or when nothing has answered in `wait` ms — the gate answers at
 * once, so silence means a route is holding the request. */
function http(port: number, path: string, headers: IncomingHttpHeaders = {}, method = "GET", body?: string, wait = 4000): Promise<Reply | null> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      const done = (): void => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() });
      if (/event-stream/.test(String(res.headers["content-type"]))) { done(); req.destroy(); return; }
      res.on("data", (c) => chunks.push(c));
      res.on("end", done);
    });
    req.setTimeout(wait, () => { resolve(null); req.destroy(); });
    req.on("error", (e) => (req.destroyed ? undefined : reject(e)));
    req.end(body);
  });
}

/** Refused by the session gate — not by a route that answers 401 itself. */
const gated = (r: Reply | null): boolean => r !== null && r.status === 401 && r.headers["www-authenticate"] !== undefined;

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

type Ask = [path: string, method: string, headers: IncomingHttpHeaders, body: string | undefined];
const concrete = (path: string): string => path.replace(/\/\*$/, "/x");
const ask = (r: Route): Ask =>
  r.method === "POST" ? [concrete(r.path), "POST", { "content-type": "application/json" }, "{}"] : [concrete(r.path), "GET", {}, undefined];

describe("the gate", () => {
  const secret = newViewerSecret();
  let now = Date.now();
  const server = createServer((req, res) => {
    armor(res);
    if (!allowLoopbackRequest(req, res)) return;
    if (!gate(req, res)) return;
    json(res, 200, { ok: true });
  });
  let port = 0, gate: ReturnType<typeof viewerGate>;
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
    port = (server.address() as { port: number }).port;
    gate = viewerGate(secret, port, () => now);
    resolve();
  }));
  afterAll(() => { server.closeAllConnections(); server.close(); });

  test("refuses without the session, as a page for a browser and JSON for anyone else", async () => {
    await ready;
    for (const method of ["GET", "POST", "HEAD", "OPTIONS"])
      expect(gated(await http(port, "/api/vault", { "content-type": "application/json" }, method, method === "POST" ? "{}" : undefined))).toBe(true);
    const page = (await http(port, "/", { accept: "text/html", "sec-fetch-dest": "document" }))!;
    expect(page.status).toBe(401);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("bigbrain open");
    expect(JSON.parse((await http(port, "/api/vault"))!.body).error).toContain("bigbrain open");
  });

  test("accepts the bearer header and the cookie, and nothing like them", async () => {
    await ready;
    expect((await http(port, "/api/vault", { authorization: `Bearer ${secret}` }))!.status).toBe(200);
    expect((await http(port, "/api/vault", { cookie: `other=1; bb_viewer_${port}=${secret}` }))!.status).toBe(200);
    const wrong = [`bb_viewer_${port + 1}=${secret}`, `bb_viewer_${port}=${secret}x`, `bb_viewer_${port}=`, `x_bb_viewer_${port}=${secret}`];
    for (const cookie of wrong) expect(gated(await http(port, "/api/vault", { cookie }))).toBe(true);
    for (const authorization of [`Basic ${secret}`, `Bearer ${secret.slice(0, 42)}`, "Bearer ", `Bearer ${secret} x`])
      expect(gated(await http(port, "/api/vault", { authorization }))).toBe(true);
    // The browser checks stay in front: a session does not let a website in.
    expect((await http(port, "/api/vault", { authorization: `Bearer ${secret}`, host: "rebind.example" }))!.status).toBe(403);
    expect((await http(port, "/api/vault", { authorization: `Bearer ${secret}`, "sec-fetch-site": "cross-site" }))!.status).toBe(403);
  });

  test("a wrong secret of any length is refused, compared in constant time", async () => {
    await ready;
    for (const given of ["", "x", secret.slice(0, 42), secret.slice(0, 42) + (secret.endsWith("A") ? "B" : "A"), secret + secret, "y".repeat(5000)])
      expect(gated(await http(port, "/api/vault", { authorization: `Bearer ${given}` }))).toBe(true);
    // Both sides are hashed to one length before timingSafeEqual: no early
    // exit on the first differing byte, and no throw on a length mismatch.
    const src = readFileSync(join(import.meta.dir, "..", "lib", "viewerSession.ts"), "utf8");
    expect(src).toContain("timingSafeEqual(digest(given), digest(secret))");
    expect(src).not.toMatch(/===\s*secret|secret\s*===|startsWith\(secret/);
  });

  test("the bootstrap sets the cookie and redirects without the secret", async () => {
    await ready;
    const r = (await http(port, `${SESSION_PATH}?workspace=w1&k=${secret}`))!;
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/?workspace=w1");
    expect(r.headers["cache-control"]).toBe("no-store");
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toBe(`bb_viewer_${port}=${secret}; HttpOnly; SameSite=Strict; Path=/`);
    expect((await http(port, "/api/vault", { cookie: cookie.split(";")[0]! }))!.status).toBe(200);
    expect((await http(port, `${SESSION_PATH}?k=${secret}`))!.headers.location).toBe("/");
    const bad = (await http(port, `${SESSION_PATH}?k=${secret.slice(1)}`))!;
    expect(gated(bad)).toBe(true);
    expect(bad.headers["set-cookie"]).toBeUndefined();
  });

  test("bigbrain open's link works for two minutes and cannot be stretched", async () => {
    await ready;
    now = Date.now();
    const link = new URL(viewerLink(port, secret, now));
    expect(link.search).not.toContain(secret);
    expect((await http(port, link.pathname + link.search))!.status).toBe(303);
    now += 121_000;
    expect(gated(await http(port, link.pathname + link.search))).toBe(true);
    now = Date.now();
    const later = new URL(viewerLink(port, secret, now + 3_600_000));
    expect(gated(await http(port, later.pathname + later.search))).toBe(true);
    const forged = new URL(viewerLink(port, newViewerSecret(), now));
    expect(gated(await http(port, forged.pathname + forged.search))).toBe(true);
  });

  test("the theme sheet agents' pages link is the one other public path", async () => {
    await ready;
    expect((await http(port, THEME_SHEET, { "sec-fetch-site": "same-site" }))!.status).toBe(200);
    expect(gated(await http(port, THEME_SHEET, { "content-type": "application/json" }, "POST", "{}"))).toBe(true);
    expect(gated(await http(port, `${THEME_SHEET}x`))).toBe(true);
  });
});

/** Wait until the spawned server answers `/api/engine` with its session. */
async function up(child: { exitCode: number | null }, home: string, port: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try { if ((await http(port, "/api/engine", viewerAuth(home, port), "GET", undefined, 500))?.status === 200) return; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error("the server exited");
    await Bun.sleep(40);
  }
  throw new Error("the server never answered with its session");
}

describe("the real servers", () => {
  test("web/server.ts: every route in its table refuses without the session", async () => {
    const home = scratchHome(), root = nativeVault({ files: { "vault.yaml": NATIVE_YAML } }), port = freePort();
    dirs.push(root);
    const child = Bun.spawn([process.execPath, "web/server.ts"], {
      env: { ...process.env, HOME: home, BIGBRAIN_VAULT: root, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_SUPERVISOR_PID: "", NODE_ENV: "test" },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      await up(child, home, port);
      // Run by hand, the viewer makes its own session, owner-only.
      expect(statSync(join(home, ".config", "bigbrain", `viewer-session-${port}`)).mode & 0o777).toBe(0o600);
      const auth = viewerAuth(home, port);
      // The table, and the handlers web/server.ts asks before it (by prefix).
      const extra = ["/api/inclusion-review", "/api/inclusion-backfill/x", "/api/models/jev", "/api/shared-settings", "/api/shared-connections", "/api/vault?workspace=x"];
      const asks: Ask[] = [...ROUTES.map(ask), ...extra.flatMap((p): Ask[] => [[p, "GET", {}, undefined], [p, "POST", { "content-type": "application/json" }, "{}"]])];
      expect(ROUTES.length).toBeGreaterThan(40);
      for (const [path, method, headers, body] of asks) {
        if (path === THEME_SHEET && method === "GET") continue; // public, above
        const refused = await http(port, path, headers, method, body);
        if (!gated(refused)) throw new Error(`${method} ${path} answered ${refused?.status} without the session`);
      }
      // With it, every read gets past the gate (writes are left alone: they act).
      for (const r of ROUTES.filter((r) => r.method === "GET")) {
        const answered = await http(port, concrete(r.path), auth);
        if (gated(answered)) throw new Error(`GET ${r.path} refused the session`);
      }
      // A browser, through the bootstrap.
      const boot = (await http(port, `${SESSION_PATH}?k=${viewerSecret(home, port)}`))!;
      expect(boot.status).toBe(303);
      const cookie = String(boot.headers["set-cookie"]).split(";")[0]!;
      expect((await http(port, "/api/vault", { cookie }))!.status).toBe(200);
      expect((await http(port, "/api/config", { cookie, "content-type": "application/json" }, "POST", '{"unknown_security_test_setting":true}'))!.status).toBe(400);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 60_000);

  test("bin/desktop.ts: the first-run door is gated the same way, with a new secret every launch", async () => {
    const home = scratchHome(), port = freePort();
    const launch = async (): Promise<string> => {
      const child = Bun.spawn([process.execPath, join(ENGINE_ROOT, "bin/desktop.ts")], {
        cwd: home,
        env: { HOME: home, PATH: process.env.PATH, BIGBRAIN_VAULT: join(home, "new-vault"), BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_DEV: "1" },
        stdin: "pipe", stdout: "ignore", stderr: "ignore",
      });
      try {
        await up(child, home, port);
        const routes: Route[] = [
          { method: "GET", path: "/", handler: () => {} },
          { method: "GET", path: "/assets/*", handler: () => {} },
          { method: "GET", path: "/api/engine", handler: () => {} },
          ...feedbackRoutes(),
          ...setupRoutes({ root: null, state: () => setupState(null), onVault: () => {} }),
        ];
        for (const r of routes) {
          const [path, method, headers, body] = ask(r);
          if (!gated(await http(port, path, headers, method, body))) throw new Error(`the door's ${method} ${path} answered without the session`);
        }
        for (const r of routes.filter((r) => r.method === "GET"))
          if (gated(await http(port, concrete(r.path), viewerAuth(home, port)))) throw new Error(`the door's GET ${r.path} refused the session`);
        const config = join(home, ".config", "bigbrain");
        expect(statSync(config).mode & 0o777).toBe(0o700);
        expect(statSync(join(config, `viewer-session-${port}`)).mode & 0o777).toBe(0o600);
        return viewerSecret(home, port)!;
      } finally {
        child.kill();
        await child.exited;
      }
    };
    const first = await launch(), second = await launch();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  }, 60_000);

  test("under the supervisor the secret is in no argv, no child's environment and no log", async () => {
    const home = scratchHome(), root = nativeVault({ files: { "vault.yaml": NATIVE_YAML } }), port = freePort(), api = freePort();
    dirs.push(root);
    const child = Bun.spawn([process.execPath, join(ENGINE_ROOT, "bin/desktop.ts")], {
      cwd: root,
      env: { HOME: home, PATH: process.env.PATH, BIGBRAIN_VAULT: root, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_API_PORT: String(api), BIGBRAIN_DESKTOP: "1", BIGBRAIN_DEV: "1", PI_OFFLINE: "1" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
    try {
      await up(child, home, port);
      const secret = viewerSecret(home, port)!;
      // The viewer behind it took the supervisor's secret: the web routes answer it.
      expect((await http(port, "/api/vault", viewerAuth(home, port)))!.status).toBe(200);
      expect((await http(port, `${SESSION_PATH}?k=${secret}`))!.status).toBe(303);
      expect((await http(port, `/no-such-route?k=${secret}`, viewerAuth(home, port)))!.status).toBe(404);
      const pids = [child.pid, ...Bun.spawnSync(["pgrep", "-P", String(child.pid)]).stdout.toString().split(/\s+/).filter(Boolean).map(Number)];
      expect(pids.length).toBeGreaterThan(2); // the supervisor, its api and its viewer
      for (const pid of pids) {
        const seen = process.platform === "linux"
          ? ["cmdline", "environ"].map((f) => { try { return readFileSync(`/proc/${pid}/${f}`, "utf8"); } catch { return ""; } }).join("\n")
          : Bun.spawnSync(["ps", "-wwE", "-o", "command=", "-p", String(pid)]).stdout.toString();
        expect(seen.length).toBeGreaterThan(0);
        expect(seen).not.toContain(secret);
      }
      const logs = join(root, ".state", "logs");
      for (const f of existsSync(logs) ? readdirSync(logs) : []) expect(readFileSync(join(logs, f), "utf8")).not.toContain(secret);
      child.kill();
      await child.exited;
      expect(await out + await err).not.toContain(secret);
      // The servers' one request log, the backstop's, names the path alone.
      for (const f of ["web/server.ts", "bin/desktop.ts", "lib/httpx.ts", "lib/viewerSession.ts"])
        expect(readFileSync(join(ENGINE_ROOT, f), "utf8")).not.toMatch(/console\.\w+\([^;]*(req\.url|url\.search|url\.href)/);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 60_000);
});
