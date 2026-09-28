import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { checkSources, noteSources } from "../lib/links";

// ── fixture: a vault with a small record tree and curated notes ──────────
// No git needed — checkSources is a pure filesystem read, like checkLinks.
function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-sources-"));
  for (const d of ["entities", "references"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
  writeFileSync(
    join(root, "references", "2026-08-02-a.md"),
    "---\nid: item-a\ntitle: A\n---\n\nhello\n"
  );
  return root;
}

const note = (root: string, rel: string, fm: string, body = "text\n"): void =>
  writeFileSync(join(root, rel), `---\n${fm}\n---\n\n${body}`);

describe("checkSources", () => {
  test("a resolvable reference id passes", () => {
    const root = vault();
    note(root, "entities/cited.md", "id: n1\nsources:\n  - item-a");
    const r = checkSources(root);
    expect(r).toEqual({ citing: 1, total: 1, unresolved: [] });
  });

  test("a resolvable reference PATH passes (slash form, same semantics as queue refs)", () => {
    const root = vault();
    note(root, "entities/cited.md", "id: n1\nsources:\n  - references/2026-08-02-a.md");
    expect(checkSources(root).unresolved).toEqual([]);
  });

  test("an unresolvable ref is reported like a broken wikilink", () => {
    const root = vault();
    note(
      root,
      "entities/bad.md",
      "id: n2\nsources:\n  - item-a\n  - no-such-item\n  - references/gone.md"
    );
    const r = checkSources(root);
    expect(r.citing).toBe(1);
    expect(r.total).toBe(3);
    expect(r.unresolved).toEqual([
      { file: "entities/bad.md", ref: "no-such-item" },
      { file: "entities/bad.md", ref: "references/gone.md" },
    ]);
  });

  test("GRANDFATHERING: notes without sources are silently fine", () => {
    const root = vault();
    note(root, "entities/old-note.md", "id: old\ntitle: pre-phase-3");
    writeFileSync(join(root, "entities", "older.md"), "no frontmatter at all\n");
    expect(checkSources(root)).toEqual({ citing: 0, total: 0, unresolved: [] });
  });

  test("malformed or non-list sources read as none (tolerant, never a new failure)", () => {
    const root = vault();
    note(root, "entities/weird.md", "id: w\nsources: 3");
    note(root, "entities/broken.md", "id: b\nsources: [unclosed"); // YAML that doesn't parse
    expect(checkSources(root)).toEqual({ citing: 0, total: 0, unresolved: [] });
  });

  test("a bare-string sources value is one ref", () => {
    const root = vault();
    note(root, "entities/bare.md", "id: s\nsources: item-a");
    expect(noteSources(root, "entities/bare.md")).toEqual(["item-a"]);
    expect(checkSources(root)).toEqual({ citing: 1, total: 1, unresolved: [] });
  });

  test("references themselves are not checked (they are sources, not citers)", () => {
    const root = vault();
    writeFileSync(
      join(root, "references", "2026-08-02-citing.md"),
      "---\nid: c\nsources:\n  - nope\n---\n\nx\n"
    );
    expect(checkSources(root).unresolved).toEqual([]);
  });
});

describe("bin/links.ts check (spawned)", () => {
  const run = (root: string) =>
    spawnSync("bun", [join(ENGINE_ROOT, "bin", "links.ts"), "check"], {
      encoding: "utf8",
      env: { ...process.env, BIGBRAIN_VAULT: root },
    });

  test("unresolved sources report in the broken-link style, exit 0 (informational)", () => {
    const root = vault();
    note(root, "entities/bad.md", "id: n\nsources:\n  - ghost-item");
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNRESOLVED SOURCES (1) — no reference has this id/path:");
    expect(r.stdout).toContain("entities/bad.md  sources: ghost-item");
    expect(r.stdout).toContain("sources: 1 ref(s) across 1 citing note(s), 1 unresolved");
  });

  test("a grandfathered vault (no sources anywhere) stays green", () => {
    const root = vault();
    note(root, "entities/old.md", "id: old\ntitle: pre-phase-3");
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("UNRESOLVED SOURCES");
    expect(r.stdout).toContain("sources: 0 ref(s) across 0 citing note(s), 0 unresolved");
  });
});
