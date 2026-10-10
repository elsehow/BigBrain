import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nativeVault, NATIVE_YAML, insertion } from "./support/vault";
import { scanSurface, type SearchFilters, type SearchHit } from "../lib/searchCore";
import { handleMcpTool } from "../lib/mcp";
import { ENGINE_ROOT } from "../lib/engine";
import { projectNotes } from "../lib/assertionProjection";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  delete process.env["BIGBRAIN_ASSERTION_DB"];
});
function fixture() {
  const root = nativeVault({ files: {
    "vault.yaml": NATIVE_YAML,
    "memory/MEMORY.md": "# Memory\n[[memory/health]] — Clinic appointment.",
    "memory/health.md": "# Health\nClinic appointment: Tuesday, 2 PM. [[ast_012345678901234567890123]]",
    "memory/health-research.md": "# Health research\nThe clinic appointment needs preparation.",
  }, insertions: [
    insertion({ id: `ins_${"1".repeat(24)}`, title: "Historical notes", body: "A clinic appointment was discussed.", received_at: "2026-08-01T00:00:00Z" }),
    insertion({ id: `ins_${"2".repeat(24)}`, title: "Health", body: "Old health notes.", received_at: "2026-08-01T00:00:00Z" }),
  ] });
  roots.push(root);
  process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
  return root;
}
function scan(root: string, query: string, filters: SearchFilters = {}, limit = 20) {
  const result = scanSurface(root, query, limit, "api", { ledger: false, filters });
  if (!result.ok) throw new Error(result.reason);
  return result;
}
function cli(root: string, query: string, role = "") {
  const r = spawnSync(process.execPath, [join(ENGINE_ROOT, "bin/search.ts"), query, "--json", "--limit", "20"], {
    env: { ...process.env, BIGBRAIN_VAULT: root, BIGBRAIN_ROLE: role }, encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as SearchHit[];
}

test("memory leads equally relevant record hits, topics precede the index, and the cap follows the merge", () => {
  const root = fixture();
  expect(scan(root, "health").hits.slice(0, 3).map(h => h.title)).toEqual(["Health", "Health", "Health research"]);
  expect(scan(root, "health").hits[0]).toMatchObject({ path: "memory/health.md", evidence: "memory", date: "" });
  expect(scan(root, "clinic appointment").hits.slice(0, 3).map(h => h.path)).toEqual([
    "memory/health-research.md", "memory/health.md", "memory/MEMORY.md",
  ]);
  expect(scan(root, "clinic appointment", {}, 1).hits[0]?.evidence).toBe("memory");
  // A strong record title still outranks an incidental memory body match.
  writeFileSync(join(root, "memory/health.md"), "# Health\nHistorical notes about the clinic.");
  projectNotes(root, ["memory/health.md"]);
  expect(scan(root, "Historical notes").hits[0]?.title).toBe("Historical notes");
});

test("UI scan, MCP and CLI return the same openable memory results", () => {
  const root = fixture();
  const expected = scan(root, "clinic appointment");
  const web = scanSurface(root, "clinic appointment", 20, "web", { ledger: false });
  expect(web.ok && web.hits).toEqual(expected.hits);
  const ctx = { root, via: "api" as const };
  const mcp = handleMcpTool(ctx, "search_vault", { query: "clinic appointment" }) as { hits: (SearchHit & { provenance: { kind: string } })[] };
  // an agent's hits are the same hits, each naming its provenance (lib/agentReads.ts)
  expect(mcp.hits.map(h => h.path)).toEqual(expected.hits.map(h => h.path));
  expect(mcp.hits.filter(h => h.evidence === "memory").map(({ provenance: _, ...h }) => h)).toEqual(expected.hits.filter(h => h.evidence === "memory"));
  expect(mcp.hits.map(h => h.provenance.kind)).toEqual(expected.hits.map(h => h.evidence === "memory" ? "memory" : expect.any(String)));
  expect(cli(root, "clinic appointment")).toEqual(expected.hits);
  const topic = mcp.hits.find(h => h.path === "memory/health.md")!;
  const note = handleMcpTool(ctx, "read_note", { path: topic.path }) as { markdown: string };
  expect(note.markdown).toContain("Tuesday, 2 PM");
});

test("explicit record filters and ingestion roles exclude memory; ordinary assistant searches include it", () => {
  const root = fixture();
  for (const filters of [{ type: "entity" }, { type: "reference" }, { after: "2000-01-01" }, { before: "2099-01-01" }] as SearchFilters[])
    expect(scan(root, "health", filters).hits.every(h => h.evidence !== "memory")).toBe(true);
  const gardener = handleMcpTool({ root, via: "gardener" }, "search_vault", { query: "health" }) as { hits: SearchHit[] };
  expect(gardener.hits.length).toBeGreaterThan(0);
  expect(gardener.hits.every(h => h.evidence !== "memory")).toBe(true);
  for (const role of ["editor", "gardener", "intake"])
    expect(cli(root, "health", role).every(h => h.evidence !== "memory")).toBe(true);
  expect(cli(root, "health", "memory")[0]?.evidence).toBe("memory");
});

test("memory-only matches prevent relaxation; zero exact matches relax across both surfaces", () => {
  const root = fixture();
  expect(scan(root, "Tuesday appointment")).toMatchObject({ relaxation: null, hits: [{ path: "memory/health.md" }] });
  expect(scan(root, "Tuesday unicorn")).toMatchObject({ relaxation: "any-term", hits: [{ path: "memory/health.md" }] });
  expect(scan(root, "???").hits).toEqual([]);
});

test("edits, nested additions, deletions and symlink replacement arrive through the notes door, without reindexing", () => {
  const root = fixture();
  expect(scan(root, "Tuesday").hits[0]?.path).toBe("memory/health.md");
  writeFileSync(join(root, "memory/health.md"), "# Health\nReplacement clinic.");
  expect(scan(root, "Tuesday").hits[0]?.path).toBe("memory/health.md"); // a read never looks at the file
  projectNotes(root, ["memory/health.md"]); // the watcher names what changed
  expect(scan(root, "Tuesday").hits).toEqual([]);
  expect(scan(root, "Replacement").hits[0]?.path).toBe("memory/health.md");
  mkdirSync(join(root, "memory/nested"));
  writeFileSync(join(root, "memory/nested/topic.md"), "# Nested\nFreshlyadded.");
  projectNotes(root, ["memory/nested"]);
  expect(scan(root, "Freshlyadded").hits[0]?.path).toBe("memory/nested/topic.md");
  rmSync(join(root, "memory/health.md"));
  projectNotes(root, ["memory/health.md"]);
  expect(scan(root, "Replacement").hits).toEqual([]);
  writeFileSync(join(root, ".env"), "SECRETWORD=must-not-appear");
  symlinkSync(join(root, ".env"), join(root, "memory/secret.md"));
  projectNotes(root, ["memory/secret.md"]);
  expect(scan(root, "SECRETWORD").hits).toEqual([]);
  rmSync(join(root, "memory"), { recursive: true });
  const outside = fixture();
  process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
  symlinkSync(join(outside, "memory"), join(root, "memory"));
  projectNotes(root, ["memory"]);
  expect(scan(root, "Tuesday").hits).toEqual([]);
});
