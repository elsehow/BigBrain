import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { applyConfig, envFieldStates } from "../lib/config";
import { readEnvValues } from "../lib/envFile";
import { loadManifest } from "../lib/manifest";
import { gitVault } from "./support/vault";

const vault = (extraYaml = ""): string => {
  const root = gitVault({
    prefix: "bb-config-",
    dirs: ["entities", ".state"],
    files: {
      "vault.yaml":
        [
          "# the manifest — hand-written, comments must survive machine edits",
          "integrations:",
          "  email: {}",
        ].join("\n") +
        "\n" +
        extraYaml,
      "entities/note.md": "---\nid: n-1\n---\nx\n",
    },
  });
  // hold the editor lock with THIS live process so the post-commit editor
  // poke exits immediately instead of racing the assertions
  mkdirSync(join(root, ".state", "editor.lock"), { recursive: true });
  writeFileSync(join(root, ".state", "editor.lock", "pid"), `${process.pid}\n`);
  return root;
};

describe("applyConfig — the two pass models (#524)", () => {
  test("each role persists reasoning, preserves it on legacy edits, and can reset it", () => {
    const root = vault();
    for (const role of ["gardener", "memory", "quick"] as const) {
      const choice = { agent: "claude" as const, model: "opus", reasoning: "high" };
      applyConfig({ [role]: choice }, root);
      expect(loadManifest(root)[role]).toMatchObject({ adapter: "pi", provider: "anthropic", model: "claude-opus-5", reasoning: choice.reasoning });
      expect(applyConfig({ [role]: choice }, root).changed).toEqual([]);
      applyConfig({ [role]: { model: "sonnet" } }, root);
      expect(loadManifest(root)[role].reasoning).toBe("high");
      applyConfig({ [role]: { agent: "codex", model: "chosen", reasoning: "xhigh" } }, root);
      expect(loadManifest(root)[role].reasoning).toBe("xhigh");
      applyConfig({ [role]: { agent: "codex", model: "chosen", reasoning: null } }, root);
      expect(loadManifest(root)[role].reasoning).toBeUndefined();
    }
  });
  test("invalid reasoning refuses the entire patch before any write", () => {
    const root = vault(), before = readFileSync(join(root, "vault.yaml"), "utf8");
    expect(() => applyConfig({ gardener: { model: "opus" }, quick: { model: "haiku", reasoning: "banana" } }, root)).toThrow("reasoning");
    expect(() => applyConfig({ gardener: { agent: "claude", model: "opus", reasoning: "ultra" } }, root)).toThrow("reasoning");
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
  });
  test("roles can use different agent sessions without replacing the legacy shared fallback", () => {
    const root = vault("curation:\n  agent: claude\n  model: opus\n");
    applyConfig({ gardener: { agent: "codex", model: "gpt-5.6" }, quick: { agent: "claude", model: "haiku" } }, root);
    const m = loadManifest(root);
    expect(m.gardener).toMatchObject({ adapter: "pi", provider: "openai-codex", model: "gpt-5.6" });
    expect(m.memory).toMatchObject({ adapter: "pi", provider: "anthropic", model: "claude-opus-5" });
    expect(m.quick).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-haiku-4-5" });
  });
  test("model: writes gardener.model; the manifest reads it back; hand-written comments survive", () => {
    const root = vault();
    const result = applyConfig({ gardener: { model: "claude-opus-5" } }, root);
    expect(result.committed).toBe(true);
    expect(result.changed).toContain("vault.yaml");
    const yaml = readFileSync(join(root, "vault.yaml"), "utf8");
    expect(yaml).toMatch(/gardener:[\s\S]*model:\s*claude-opus-5/);
    expect(yaml).toContain("# the manifest — hand-written");
    expect(loadManifest(root).gardener.model).toBe("claude-opus-5");
  });

  // A vault written before the rename keeps its `queue:` block, and
  // loadManifest still reads the model there. An edit must land in that same
  // block: writing a second `gardener:` one would leave two models in the
  // file, only one of them live.
  test("a vault that still says queue: is edited IN PLACE, not given a second block", () => {
    const root = vault(["queue:", "  model: claude-sonnet-5", ""].join("\n"));
    applyConfig({ gardener: { model: "claude-opus-5" } }, root);
    const yaml = readFileSync(join(root, "vault.yaml"), "utf8");
    expect(yaml).toMatch(/queue:[\s\S]*model:\s*claude-opus-5/);
    expect(yaml).not.toMatch(/gardener:/);
    expect(loadManifest(root).gardener.model).toBe("claude-opus-5");
  });

  test("a memory patch writes memory.model, on its own", () => {
    const root = vault();
    applyConfig({ memory: { model: "claude-fable-5" } }, root);
    expect(loadManifest(root).memory.model).toBe("claude-fable-5");
  });

  test("both models in one patch, each in its own block", () => {
    const root = vault();
    applyConfig({ gardener: { model: "claude-opus-5" }, memory: { model: "claude-fable-5" } }, root);
    const m = loadManifest(root);
    expect(m.gardener.model).toBe("claude-opus-5");
    expect(m.memory.model).toBe("claude-fable-5");
  });

  test("an implausible model id is rejected before any write; an empty model is a no-op", () => {
    const root = vault();
    const before = readFileSync(join(root, "vault.yaml"), "utf8");
    expect(() => applyConfig({ gardener: { model: "not a model!" } }, root)).toThrow(
      /gardener model .* is not a plausible model id/
    );
    expect(() => applyConfig({ memory: { model: "also bad!" } }, root)).toThrow(
      /memory model .* is not a plausible model id/
    );
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
    const result = applyConfig({ gardener: { model: "  " } }, root);
    expect(result.committed).toBe(false);
    expect(result.changed).toEqual([]);
  });

  test("re-saving the model it already has changes nothing", () => {
    const root = vault();
    applyConfig({ gardener: { model: "claude-opus-5" } }, root);
    const result = applyConfig({ gardener: { model: "claude-opus-5" } }, root);
    expect(result.changed).toEqual([]);
    expect(result.committed).toBe(false);
  });
});

describe("applyConfig — integrations", () => {
  test("integration toggle: enabled:false is set and cleared in place; config keys and comments survive", () => {
    const root = vault();
    applyConfig({ integrations: [{ name: "email", enabled: false }] }, root);
    let m = loadManifest(root);
    expect((m.integrations["email"] ?? {})["enabled"]).toBe(false);
    applyConfig({ integrations: [{ name: "email", enabled: true }] }, root);
    m = loadManifest(root);
    expect("enabled" in (m.integrations["email"] ?? {})).toBe(false);
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toContain(
      "# the manifest — hand-written"
    );
  });
});

describe("integration credentials land in the vault's own .env", () => {
  test("a credential lands in <vault>/.env, shell-single-quoted", () => {
    const root = vault();
    applyConfig(
      { integrations: [{ name: "that-tracks", env: { THAT_TRACKS_API_KEY: "gk-default" } }] },
      root
    );
    // values are shell-single-quoted so the file is safe to dot-source (#550)
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("THAT_TRACKS_API_KEY='gk-default'");
  });

  test("the credential file is 0600", () => {
    const root = vault();
    applyConfig({ integrations: [{ name: "that-tracks", env: { THAT_TRACKS_API_KEY: "gk-mode" } }] }, root);
    expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
  });

  test("envFieldStates reads set-ness back; secrets stay write-only", () => {
    const root = vault();
    applyConfig({ integrations: [{ name: "that-tracks", env: { THAT_TRACKS_API_KEY: "gk-read" } }] }, root);
    const [field] = envFieldStates(root, "that-tracks");
    expect(field!.set).toBe(true);
    expect(field!.value).toBeUndefined(); // secret: reported set, never returned
  });
});

describe("integration credentials are injection-proof (#550)", () => {
  const dotSource = (root: string): string => {
    const r = spawnSync("sh", ["-c", 'set -a; . ./.env; set +a; printf %s "$THAT_TRACKS_API_KEY"'], {
      cwd: root,
      encoding: "utf8",
    });
    return r.stdout ?? "";
  };

  test("a shell-metachar value round-trips and executes nothing when dot-sourced", () => {
    const root = vault();
    const sentinel = join(root, "PWNED");
    // $(...), backticks, ; and a single quote — every shell weapon at once.
    const payload =
      "tok-$(touch " + sentinel + ")-`touch " + sentinel + "`-;touch " + sentinel + "-'q'";
    applyConfig({ integrations: [{ name: "that-tracks", env: { THAT_TRACKS_API_KEY: payload } }] }, root);

    const raw = readFileSync(join(root, ".env"), "utf8");
    expect(raw).toContain("THAT_TRACKS_API_KEY='"); // single-quoted, never bare
    expect(readEnvValues(root)["THAT_TRACKS_API_KEY"]).toBe(payload); // exact engine round-trip
    expect(dotSource(root)).toBe(payload); // /bin/sh saw the literal string...
    expect(existsSync(sentinel)).toBe(false); // ...and ran none of it
  });

  test("an unrelated shell-active value survives a credential rewrite", () => {
    const root = vault();
    applyConfig({ integrations: [{ name: "that-tracks", env: { THAT_TRACKS_API_KEY: "first'val" } }] }, root);
    applyConfig({ integrations: [{ name: "that-tracks", env: { THAT_TRACKS_API_KEY: "second$val" } }] }, root);
    expect(readEnvValues(root)["THAT_TRACKS_API_KEY"]).toBe("second$val");
    expect(dotSource(root)).toBe("second$val");
  });

  test("newline / NUL / CR / tab in a credential is refused before any write", () => {
    const root = vault();
    const nl = String.fromCharCode(10);
    const nul = String.fromCharCode(0);
    const cr = String.fromCharCode(13);
    const tab = String.fromCharCode(9);
    for (const bad of ["x" + nl + "BAD=y", "x" + nul + "y", "x" + cr + "y", "x" + tab + "y"]) {
      expect(() =>
        applyConfig({ integrations: [{ name: "that-tracks", env: { THAT_TRACKS_API_KEY: bad } }] }, root)
      ).toThrow(/control characters/);
    }
    expect(existsSync(join(root, ".env"))).toBe(false); // nothing partial written
  });
});
