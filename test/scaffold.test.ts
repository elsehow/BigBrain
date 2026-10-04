import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { ensureStoragePlanes, scaffoldVault, shedVaultPrompts } from "../lib/scaffold";

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "bb-scaffold-"));
}

describe("ensureStoragePlanes", () => {
  test("fresh vault: creates references/.gitkeep and an empty .blobs/", () => {
    const root = tmpVault();
    const changed = ensureStoragePlanes(root);
    expect(changed).toEqual(["references/.gitkeep"]);
    expect(existsSync(join(root, "references", ".gitkeep"))).toBe(true);
    expect(existsSync(join(root, ".blobs"))).toBe(true);
  });

  test("references/ already has content: no-op, .gitkeep not added", () => {
    const root = tmpVault();
    mkdirSync(join(root, "references"), { recursive: true });
    writeFileSync(join(root, "references", "2026-08-02-x.md"), "---\nid: x\n---\nbody\n");
    const changed = ensureStoragePlanes(root);
    expect(changed).toEqual([]);
    expect(existsSync(join(root, "references", ".gitkeep"))).toBe(false);
  });

  test("idempotent: a second call reports nothing new", () => {
    const root = tmpVault();
    ensureStoragePlanes(root);
    expect(ensureStoragePlanes(root)).toEqual([]);
  });
});

describe("shedVaultPrompts (#524 migration)", () => {
  test("a pre-#524 vault's prompt copies are shed, dead ones included", () => {
    // The live case, 2026-08-31: this vault carried memory.md frozen at
    // 2026-08-28 plus editor.md, import.md and discuss.md for passes retired
    // weeks earlier — and the readers preferred the vault's copy, so four
    // engine prompt fixes had reached nobody.
    const root = mkdtempSync(join(tmpdir(), "bb-shed-"));
    mkdirSync(join(root, "prompts"), { recursive: true });
    for (const f of ["memory.md", "tend.md", "editor.md", "import.md"])
      writeFileSync(join(root, "prompts", f), "stale\n");
    writeFileSync(join(root, "prompts", "VERSION"), "6\n");
    expect(shedVaultPrompts(root)).toEqual([
      "prompts/VERSION",
      "prompts/editor.md",
      "prompts/import.md",
      "prompts/memory.md",
      "prompts/tend.md",
    ]);
    // the directory goes with the last file — an empty prompts/ in a vault
    // is the invitation that started this
    expect(existsSync(join(root, "prompts"))).toBe(false);
  });

  test("a vault with no prompts/ is untouched, and shedding twice is a no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-shed-none-"));
    expect(shedVaultPrompts(root)).toEqual([]);
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "memory.md"), "x\n");
    expect(shedVaultPrompts(root)).toEqual(["prompts/memory.md"]);
    expect(shedVaultPrompts(root)).toEqual([]);
  });

  test("a non-prompt file keeps the directory alive", () => {
    // Not ours to delete: shed the prompts, leave whatever else someone put
    // there, and leave the directory standing for it.
    const root = mkdtempSync(join(tmpdir(), "bb-shed-other-"));
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "memory.md"), "x\n");
    writeFileSync(join(root, "prompts", "notes.txt"), "mine\n");
    expect(shedVaultPrompts(root)).toEqual(["prompts/memory.md"]);
    expect(existsSync(join(root, "prompts", "notes.txt"))).toBe(true);
  });
});

describe("the engine's prompts", () => {
  test("every prompt the engine ships is one something reads", () => {
    // An orphan here used to be an orphan in every user's record, because
    // seedPrompts copied EVERY prompts/*.md into every vault:
    // prompts/discuss.md sat in one from 2026-08 until #507, still telling
    // agents to `Read prompts/discuss.md` — an idiom the viewer had already
    // dropped for the plugin's HTTP command. Seeding went with #524 and the
    // prompts are the engine's now, but the rule stands: the readers are
    // lib/memoryRun.ts (memory.md), lib/tend.ts (tend.md),
    // lib/entityFolds.ts (entity-folds.md, #728), lib/pilot.ts (pilot.md,
    // #770 — the realtime session's instructions) and lib/goalChain.ts
    // (goals-source.md and goals-picture.md, #51); add a name here only
    // with its reader. (email-triage.md came and went in #744/#756: the
    // gardener triages staged mail itself, through tend.md.)
    const prompts = readdirSync(join(ENGINE_ROOT, "prompts")).filter((f) => f.endsWith(".md"));
    expect(prompts.sort()).toEqual(["entity-folds.md", "goals-picture.md", "goals-source.md", "memory.md", "pilot.md", "tend.md"]);
  });

  // A fresh vault gets no prompts/ at all: a prompt is the engine's text,
  // versioned with the engine, not a per-vault setting to migrate.
  test("scaffoldVault seeds no prompts directory", () => {
    const root = tmpVault();
    expect(scaffoldVault(root).some((p) => p.startsWith("prompts/"))).toBe(false);
    expect(existsSync(join(root, "prompts"))).toBe(false);
  });
});

describe("the retired skills (#45 decision 8, #507)", () => {
  test("the engine keeps its own development skills — and ships none of them", () => {
    // `setup` and `verify` are THIS checkout's skills: /verify tells you to
    // run `bun install` and build the viewer against a sandbox vault, which
    // is engine work, not vault work. They stay here and are not scaffolded.
    const skills = readdirSync(join(ENGINE_ROOT, ".claude", "skills"));
    expect(skills).not.toContain("vault-search");
    expect(skills).not.toContain("vault-add");
    expect(skills).toContain("setup");
    expect(skills).toContain("verify");
  });

  test("a fresh vault gets no skills directory at all", () => {
    const root = tmpVault();
    const changed = scaffoldVault(root);
    expect(changed.filter((p) => p.startsWith(".claude/skills/"))).toEqual([]);
    expect(existsSync(join(root, ".claude", "skills"))).toBe(false);
  });

  test("an already-provisioned vault has them removed, and it is reported", () => {
    // Un-copying is not enough: they are on disk in every vault provisioned so
    // far, and a skill nothing writes any more is still a skill agents read.
    const root = tmpVault();
    for (const skill of ["vault-search", "vault-add", "setup", "verify"]) {
      mkdirSync(join(root, ".claude", "skills", skill), { recursive: true });
      writeFileSync(
        join(root, ".claude", "skills", skill, "SKILL.md"),
        "---\nname: x\n---\nstale\n"
      );
    }
    mkdirSync(join(root, ".claude", "skills", "mine"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "mine", "SKILL.md"),
      "---\nname: mine\n---\nkeep\n"
    );

    const changed = scaffoldVault(root);

    for (const skill of ["vault-search", "vault-add", "setup", "verify"]) {
      expect(existsSync(join(root, ".claude", "skills", skill))).toBe(false);
      expect(changed).toContain(`.claude/skills/${skill}/SKILL.md`);
    }
    // A vault's OWN local skills are still never deleted.
    expect(existsSync(join(root, ".claude", "skills", "mine", "SKILL.md"))).toBe(true);
  });

  test("a vault that never had them is untouched by the retraction", () => {
    const root = tmpVault();
    scaffoldVault(root);
    const changed = scaffoldVault(root);
    expect(changed.filter((p) => p.includes("vault-search") || p.includes("vault-add"))).toEqual(
      []
    );
  });
});
