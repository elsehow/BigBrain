import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { allowVaultRequest, vaultIdentity, VAULT_HEADER } from "../lib/vaultBoundary";
import { VaultScope } from "../web/ui/src/lib/vaultScope";

test("vault identity survives process restarts and canonicalizes path aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-vault-boundary-"));
  try {
    symlinkSync(root, root + "-alias");
    expect(vaultIdentity(root)).toBe(vaultIdentity(root + "-alias"));
    expect(vaultIdentity(root)).not.toBe(vaultIdentity(root + "/other"));
    expect(vaultIdentity(null)).toBe("setup");
  } finally { rmSync(root + "-alias"); rmSync(root, { recursive: true, force: true }); }
});

test("old tab cannot write into the new vault, and learns its identity", async () => {
  let writes = 0;
  const server = createServer((req, res) => {
    if (!allowVaultRequest(req, res, "B")) return;
    writes++; res.end("ok");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { [VAULT_HEADER]: "A" } });
    expect(result.status).toBe(409); expect(result.headers.get(VAULT_HEADER)).toBe("B"); expect(writes).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("A → B → A, reload, and multiple tabs preserve only their own pending data", async () => {
  let current = "A", reloads = 0, writes = 0;
  const transport: typeof fetch = async (_input, init) => {
    const expected = new Headers(init?.headers).get(VAULT_HEADER);
    if (init?.method === "POST" && expected === current) writes++;
    return Response.json({ vault: current }, { status: expected && expected !== current ? 409 : 200, headers: { [VAULT_HEADER]: current } });
  };
  const storage = new Map<string, string>();
  const first = new VaultScope(transport, () => reloads++), otherTab = new VaultScope(transport, () => reloads++);
  await Promise.all([first.initialize(), otherTab.initialize()]);
  storage.set(first.key("pending"), "delivery-A");
  storage.set(first.key("draft"), "Invented A draft");
  current = "B";
  await expect(first.fetch("/api/action", { method: "POST" })).rejects.toThrow("active vault changed");
  await expect(otherTab.fetch("/api/note")).rejects.toThrow("active vault changed");
  expect(writes).toBe(0); expect(reloads).toBe(2);
  await expect(first.fetch("/api/action", { method: "POST" })).rejects.toThrow("active vault changed");
  const second = new VaultScope(transport, () => reloads++); await second.initialize();
  expect(storage.get(second.key("pending"))).toBeUndefined();
  storage.set(second.key("draft"), "Invented B draft");
  current = "A";
  const restored = new VaultScope(transport, () => reloads++); await restored.initialize();
  expect(storage.get(restored.key("pending"))).toBe("delivery-A");
  expect(storage.get(restored.key("draft"))).toBe("Invented A draft");
  const restarted = new VaultScope(transport, () => reloads++); await restarted.initialize();
  expect(restarted.key("pending")).toBe(restored.key("pending"));
});

test("late response headers and delayed body reads cannot escape a changed scope", async () => {
  let release!: (value: Response) => void;
  const scope = new VaultScope(async input => input === "/api/vault"
    ? Response.json({}, { headers: { [VAULT_HEADER]: "A" } })
    : new Promise<Response>(resolve => { release = resolve; }), () => {});
  await scope.initialize();
  const late = scope.fetch("/api/note");
  await Promise.resolve();
  scope.observe("B");
  release(Response.json({ private: "Invented A note" }, { headers: { [VAULT_HEADER]: "A" } }));
  await expect(late).rejects.toThrow("active vault changed");
  const second = new VaultScope(async () => Response.json({}, { headers: { [VAULT_HEADER]: "A" } }), () => {});
  const response = await second.fetch("/api/note"); second.observe("B");
  await expect(response.json()).rejects.toThrow("active vault changed");
});

test("failed bootstrap exposes no prior cache namespace and can recover", async () => {
  let failed = true;
  const scope = new VaultScope(async () => failed ? new Response("offline", { status: 503 }) : Response.json({}, { headers: { [VAULT_HEADER]: "B" } }), () => {});
  await expect(scope.initialize()).rejects.toThrow("unavailable"); expect(scope.ready()).toBe(false);
  failed = false; await scope.initialize(); expect(scope.ready()).toBe(true); expect(scope.key("cache")).toContain(":B:");
});
