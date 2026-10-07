import { afterAll, describe, expect, test } from "bun:test";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowLoopbackRequest, armor, json, THEME_SHEET } from "../lib/httpx";
import { nativeVault, NATIVE_YAML } from "./support/vault";

const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

function http(port: number, path: string, headers: IncomingHttpHeaders = {}, method = "GET", body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("loopback guard rejects browser/rebinding requests before any handler runs", async () => {
  let reached = 0;
  const server = createServer((req, res) => {
    armor(res);
    if (!allowLoopbackRequest(req, res)) return;
    reached++;
    json(res, 200, { ok: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const host = `127.0.0.1:${port}`, origin = `http://${host}`;
  try {
    const refused: IncomingHttpHeaders[] = [
      { host: "rebind.example" }, { host: "localhost.example" },
      { host: "127.0.0.1@example.com" }, { host: "localhost:99999" },
      { host: "localhost.", "x-forwarded-host": host },
      { host, origin: "https://attacker.example" }, { host, origin: "null" },
      { host, origin: "http://localhost:1" }, { host, origin: `${origin}/` },
      { host, "sec-fetch-site": "cross-site" }, { host, "sec-fetch-site": "same-site" },
    ];
    for (const headers of refused) {
      expect((await http(port, "/api/private", headers)).status).toBe(403);
      expect((await http(port, "/api/write", { ...headers, "content-type": "application/json" }, "POST", "{}")).status).toBe(403);
    }
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=test"])
      expect((await http(port, "/api/write", { host, ...(type ? { "content-type": type } : {}) }, "POST", "{}")).status).toBe(415);
    expect(reached).toBe(0);
    // An agent's page on another loopback port may load the theme sheet, and nothing else
    expect((await http(port, THEME_SHEET, { host, "sec-fetch-site": "same-site" })).status).toBe(200);
    for (const [path, headers, method] of [[THEME_SHEET, { host, "sec-fetch-site": "cross-site" }, "GET"], [THEME_SHEET, { host: "rebind.example", "sec-fetch-site": "same-site" }, "GET"],
      [THEME_SHEET, { host, "sec-fetch-site": "same-site", "content-type": "application/json" }, "POST"], [`${THEME_SHEET}/..`, { host, "sec-fetch-site": "same-site" }, "GET"]] as const)
      expect((await http(port, path, headers, method, method === "POST" ? "{}" : undefined)).status).toBe(403);
    expect((await http(port, "/", { host, "sec-fetch-site": "none" })).status).toBe(200);
    expect((await http(port, "/api/write", { host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json; charset=utf-8" }, "POST", "{}")).status).toBe(200);
    // Native tools omit Origin. Vite and SSH tunnels may use another loopback port.
    for (const authority of [host, "localhost:5173", "[::1]:5173"])
      expect((await http(port, "/api/write", { host: authority, "content-type": "application/json" }, "POST", "{}")).status).toBe(200);
    expect((await http(port, "/api/write", { host: "localhost:5173", origin: "http://localhost:5173", "content-type": "application/json" }, "POST", "{}")).status).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe("production HTTP entrypoints enforce the boundary", () => {
  for (const entry of ["web/server.ts", "bin/desktop.ts"]) test(entry, async () => {
    const root = entry === "web/server.ts" ? nativeVault({ files: { "vault.yaml": NATIVE_YAML } }) : mkdtempSync(join(tmpdir(), "bb-security-door-"));
    roots.push(root);
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probe.port!; probe.stop(true);
    const child = Bun.spawn([process.execPath, entry], {
      // The supervisor tightens ~/.config/bigbrain at start: never the real one.
      env: { ...process.env, BIGBRAIN_VAULT: root, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_SUPERVISOR_PID: "", BIGBRAIN_DEV: "1", ...(entry === "bin/desktop.ts" ? { HOME: root } : {}) },
      stdin: "pipe", stdout: "ignore", stderr: "ignore",
    });
    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try { if ((await http(port, "/api/engine")).status === 200) { ready = true; break; } } catch { /* boot */ }
        await Bun.sleep(40);
      }
      expect(ready).toBe(true);
      expect((await http(port, "/api/engine", { host: "rebind.example" })).status).toBe(403);
      const path = entry === "web/server.ts" ? "/api/config" : "/api/setup/identity";
      const before = entry === "web/server.ts" ? readFileSync(join(root, "vault.yaml"), "utf8") : null;
      expect((await http(port, path, { origin: "https://attacker.example", "content-type": "text/plain" }, "POST", "{}")).status).toBe(403);
      expect((await http(port, path, { "content-type": "text/plain" }, "POST", "{}")).status).toBe(415);
      if (before !== null) expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
      // The same safe JSON request reaches the actual route (invalid setting / no vault).
      const valid = await http(port, path, { "content-type": "application/json" }, "POST", '{"unknown_security_test_setting":true}');
      expect(valid.status).toBe(entry === "web/server.ts" ? 400 : 409);
    } finally {
      child.kill(); await child.exited;
    }
  }, 15_000);
});
