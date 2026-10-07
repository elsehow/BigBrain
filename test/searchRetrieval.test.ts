import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nativeVault, NATIVE_YAML, insertion } from "./support/vault";
import { scanSurface } from "../lib/searchCore";
import { handleMcpTool } from "../lib/mcp";
import { pilotToolCall } from "../lib/pilot";
import { ENGINE_ROOT } from "../lib/engine";

const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = nativeVault({ files: { "vault.yaml": NATIVE_YAML,
    "memory/MEMORY.md": "# Memory\n[[memory/health]] — GI appointment.",
    "memory/health.md": "# Health\nGI appointment: Tuesday, 2 PM, Example Clinic. [[ast_012345678901234567890123]]",
  }, insertions: [
    insertion({ id: `ins_${"1".repeat(24)}`, title: "Pilot conversation", body: "gastro OR GI OR gastroenterology OR appointment. Nothing found.", envelope: { source: "pilot", kind: "pilot-chat" } }),
    insertion({ id: `ins_${"2".repeat(24)}`, title: "Treasury research", body: "Treasury bonds and government debt.", envelope: { source: "api", kind: "web-clip" } }),
    insertion({ id: `ins_${"3".repeat(24)}`, title: "Corporate research", body: "Corporate bonds finance investment.", envelope: { source: "email", kind: "email" } }),
  ] }); roots.push(root); return root;
}
function scan(root: string, q: string, filters = {}) {
  const r = scanSurface(root, q, 20, "api", { ledger: false, filters });
  if (!r.ok) throw new Error(r.reason);
  return r;
}
test("the gastro OR query finds openable health memory ahead of the old pilot answer", async () => {
  const root = fixture();
  const q = "gastro OR GI OR gastroenterology OR appointment";
  const result = scan(root, q);
  expect(result.hits[0]).toMatchObject({ path: "memory/health.md", evidence: "memory", date: "" });
  expect(result.relaxation).toBeNull();
  expect(result.only_agent_records).toBe(false);
  const ctx = { root, via: "api" as const };
  const note = handleMcpTool(ctx, "read_note", { path: result.hits[0]!.path }) as any;
  expect(note.markdown).toContain("Tuesday, 2 PM");
  const alternatives = ["gastro", "GI", "gastroenterology", "appointment"];
  const mcp = handleMcpTool(ctx, "search_vault", { queries: alternatives }) as any;
  const pilot = await pilotToolCall(root, "search_vault", { queries: alternatives }) as any;
  // an agent's hits are the same hits, each naming its provenance (lib/agentReads.ts)
  expect(mcp.hits.map((h: { path: string }) => h.path)).toEqual(result.hits.map(h => h.path));
  expect(mcp.hits.map((h: { provenance: { kind: string } }) => h.provenance.kind)).toEqual(["memory", "memory", "agent"]);
  expect(pilot).toEqual(mcp);
  const cli = spawnSync(process.execPath, [join(ENGINE_ROOT, "bin/search.ts"), q, "--json", "--limit", "20"], {
    env: { ...process.env, BIGBRAIN_VAULT: root }, encoding: "utf8",
  });
  expect(cli.status).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual(result.hits);
});
test("OR groups preserve conjunctions and do not leak through explicit scope filters", () => {
  const root = fixture();
  expect(scan(root, "Treasury bonds OR corporate bonds").hits.map(h => h.title).sort()).toEqual(["Corporate research", "Treasury research"]);
  const email = scan(root, "Treasury bonds OR corporate bonds", { source: "email" });
  expect(email.hits.map(h => h.title)).toEqual(["Corporate research"]);
  expect(email.applied_filters).toEqual({ source: "email" });
  for (const filters of [{ source: "pilot" }, { type: "entity" }, { type: "reference" }, { after: "2000-01-01" }, { before: "2099-01-01" }])
    expect(scan(root, "GI appointment", filters).hits.every(h => h.evidence !== "memory")).toBe(true);
  const chats = scan(root, "gastro", { source: "pilot" });
  expect(chats.only_agent_records).toBe(true);
  expect(chats.hits[0]?.evidence).toBe("agent-conversation");
});
test("bad alternatives return a repairable query error, never literal OR matches or a cache error", () => {
  const root = fixture();
  for (const query of ["gastro OR", "OR bonds", "gastro OR OR bonds", Array(9).fill("debt").join(" OR ")]) {
    expect(scanSurface(root, query, 5, "api", { ledger: false })).toMatchObject({ ok: false, invalid_query: true });
  }
  const ctx = { root, via: "api" as const };
  for (const args of [{ queries: [] }, { query: "debt", queries: ["bonds"] }, { queries: [null] }])
    expect(() => handleMcpTool(ctx, "search_vault", args)).toThrow("Use query OR queries");
  expect(scan(root, "???").hits).toEqual([]);
});
test("short uppercase abbreviations match whole words, not unrelated prefixes", () => {
  const root = fixture();
  writeFileSync(join(root, "memory/giving.md"), "# Giving\nGift ideas, giving advice, Gil.");
  expect(scan(root, "GI").hits.some(h => h.path === "memory/giving.md")).toBe(false);
  expect(scan(root, "GI").hits.some(h => h.path === "memory/health.md")).toBe(true);
  expect(scan(root, "gi").hits.some(h => h.path === "memory/giving.md")).toBe(true);
});
test("memory edits, additions and deletions refresh without restart; symlinks cannot leak files", () => {
  const root = fixture();
  expect(scan(root, "Example Clinic").hits[0]?.path).toBe("memory/health.md");
  writeFileSync(join(root, "memory/health.md"), "# Health\nReplacement clinic.");
  expect(scanSurface(root, "Example Clinic", 20, "api", { ledger: false, relax: false })).toMatchObject({ ok: true, hits: [] });
  expect(scan(root, "Replacement").hits[0]?.path).toBe("memory/health.md");
  mkdirSync(join(root, "memory/nested"));
  writeFileSync(join(root, "memory/nested/topic.md"), "# Nested\nFreshlyadded.");
  expect(scan(root, "Freshlyadded").hits[0]?.path).toBe("memory/nested/topic.md");
  rmSync(join(root, "memory/health.md"));
  expect(scan(root, "Replacement").hits).toEqual([]);
  writeFileSync(join(root, ".env"), "SECRETWORD=must-not-appear");
  symlinkSync(join(root, ".env"), join(root, "memory/secret.md"));
  expect(scan(root, "SECRETWORD").hits).toEqual([]);
  // Even the memory directory itself must stay inside the read jail.
  rmSync(join(root, "memory"), { recursive: true });
  const outside = fixture();
  symlinkSync(join(outside, "memory"), join(root, "memory"));
  expect(scan(root, "Example Clinic").hits).toEqual([]);
});
test("original sources survive the candidate cap when many conversations match better", () => {
  const chats = Array.from({ length: 120 }, (_, i) => insertion({ id: `ins_${i.toString(16).padStart(24, "0")}`, title: "Debt", body: "Debt debt debt.", envelope: { source: "agent-chat", kind: "agent-chat" } }));
  const root = nativeVault({ files: { "vault.yaml": NATIVE_YAML }, insertions: [...chats,
    insertion({ id: `ins_${"f".repeat(24)}`, title: "Original research", body: "A source discussing debt markets in detail.", envelope: { source: "api", kind: "web-clip" } }),
  ] }); roots.push(root);
  const r = scanSurface(root, "debt", 1, "api", { ledger: false });
  expect(r).toMatchObject({ ok: true, hits: [{ title: "Original research" }], only_agent_records: false });
  expect(scan(root, "debt", { source: "agent-chat" }).hits[0]?.title).toBe("Debt");
});
