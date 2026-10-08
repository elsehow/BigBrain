import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSave, integrationsInfo } from "../lib/configWrite";
import { loadManifest } from "../lib/manifest";

// The viewer's one write surface (#291, the config half of #260): the
// request → config-file mapping.

/** A scratch vault (the config.test.ts recipe): git-initialized so
 * applyConfig can commit, editor lock held by THIS process so the
 * post-commit poke exits instead of racing the assertions. */
const vault = (opts: { extraYaml?: string } = {}): string => {
  const root = mkdtempSync(join(tmpdir(), "bb-configwrite-"));
  for (const d of ["entities", ".state"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(
    join(root, "vault.yaml"),
    ["# hand-written — comments must survive machine edits", "integrations:", "  granola: {}"].join(
      "\n"
    ) +
      "\n" +
      (opts.extraYaml ?? "")
  );
  writeFileSync(join(root, "entities", "note.md"), "---\nid: n-1\n---\nx\n");
  const g = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "test@test"]);
  g(["config", "user.name", "test"]);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  mkdirSync(join(root, ".state", "editor.lock"), { recursive: true });
  writeFileSync(join(root, ".state", "editor.lock", "pid"), `${process.pid}\n`);
  return root;
};

describe("configSave — the request → config-file mapping", () => {
  test("a model patch lands in vault.yaml's gardener block, committed, comments intact", async () => {
    const root = vault();
    const r = await configSave(root, JSON.stringify({ gardener: { model: "claude-opus-5" } }));
    expect(r.status).toBe(200);
    const result = JSON.parse(r.body) as { changed: string[]; committed: boolean };
    expect(result.changed).toContain("vault.yaml");
    expect(result.committed).toBe(true);
    const yaml = readFileSync(join(root, "vault.yaml"), "utf8");
    expect(yaml).toMatch(/gardener:[\s\S]*model:\s*claude-opus-5/);
    expect(yaml).toContain("# hand-written");
  });

  test("an integration toggle lands under integrations: in vault.yaml", async () => {
    const root = vault();
    const patch = { integrations: [{ name: "granola", enabled: false }] };
    const r = await configSave(root, JSON.stringify(patch));
    expect(r.status).toBe(200);
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toMatch(
      /granola:[\s\S]*?enabled:\s*false/
    );
  });

  test("a rejected patch writes nothing — validation precedes every write", async () => {
    const root = vault();
    const before = readFileSync(join(root, "vault.yaml"), "utf8");
    const r = await configSave(root, JSON.stringify({ gardener: { model: "not a model!!" } }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toContain("not a plausible model id");
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
  });

  test("malformed JSON is a 400, not a throw", async () => {
    const r = await configSave(vault(), "{nope");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toBeTruthy();
  });

});

describe("integrationsInfo — what the settings screen is told", () => {
  test("a RETIRED integration stays hidden even when vault.yaml still names it", () => {
    const root = vault({ extraYaml: "" });
    writeFileSync(
      join(root, "vault.yaml"),
      ["integrations:", "  outbox: {}", "  granola:", "    workspace: acme", ""].join("\n")
    );
    const rows = integrationsInfo(root, loadManifest(root)) as { name: string }[];
    expect(rows.map((r) => r.name)).not.toContain("outbox");
    expect(rows.map((r) => r.name)).toContain("granola");
  });

  test("a listed entry: enabled unless enabled:false; opaque keys render back to YAML; engine code detected", () => {
    const root = vault();
    writeFileSync(
      join(root, "vault.yaml"),
      [
        "integrations:",
        "  granola:",
        "    workspace: acme",
        "  agent-chat:",
        "    enabled: false",
        "",
      ].join("\n")
    );
    const rows = integrationsInfo(root, loadManifest(root)) as {
      name: string;
      kind: string;
      enabled: boolean;
      configYaml: string;
      hasCode: boolean;
    }[];
    const granola = rows.find((r) => r.name === "granola")!;
    expect(granola.kind).toBe("poller");
    expect(granola.enabled).toBe(false); // Saved credentials/config alone do not activate.
    expect(granola.configYaml).toBe("workspace: acme\n"); // `enabled` never rides along
    expect(granola.hasCode).toBe(true); // integrations/granola ships in the engine
    expect(rows.find((r) => r.name === "agent-chat")).toBeUndefined();
  });

  test("hasTrigger: an integration with a cadence says it runs on its own", () => {
    // Until #645 this was read off the integration's launchd plist. Deleting
    // those files flipped every row to false with nothing failing — the
    // viewer just quietly stopped saying "runs on its own trigger" and
    // started calling a poll a run. Pinned so the next move is loud.
    const root = vault();
    writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
    const rows = integrationsInfo(root, loadManifest(root)) as {
      name: string;
      hasTrigger: boolean;
    }[];
    expect(rows.find((r) => r.name === "granola")!.hasTrigger).toBe(true);
    expect(rows.find((r) => r.name === "agent-chat")).toBeUndefined();
  });

  test("supported integrations are offered; unconfigured legacy sources stay hidden", () => {
    const root = vault();
    writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
    const rows = integrationsInfo(root, loadManifest(root)) as {
      name: string;
      enabled: boolean;
    }[];
    expect(rows.find(r=>r.name==="email")).toBeUndefined();
    expect(rows.find(r=>r.name==="that-tracks")).toBeUndefined();
    expect(rows.find(r=>r.name==="granola")?.enabled).toBe(false);
  });
});

describe("configSave — a patch this engine does not understand", () => {
  test("an unknown key is refused, not ignored: a stale tab's save must not report success", async () => {
    // The pre-#643 bundle sent { model, memoryModel }; a tab still holding
    // it would otherwise get 200 with changed: [] and show "saved".
    const root = vault();
    const before = readFileSync(join(root, "vault.yaml"), "utf8");
    const r = await configSave(root, JSON.stringify({ model: "claude-opus-5" }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toContain("no setting called \"model\"");
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
  });
});


describe("That Tracks connection", () => {
  test("validate before saving; rejected keys never enable the integration or touch credentials", async () => {
    const root = vault();
    const before = readFileSync(join(root, "vault.yaml"), "utf8");
    const patch = JSON.stringify({ integrations: [{ name: "that-tracks", env: { THAT_TRACKS_API_KEY: "tt_synthetic" } }] });
    const rejected = await configSave(root, patch, undefined, async () => { throw new Error("Key rejected"); });
    expect(rejected.status).toBe(400);
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
    const accepted = await configSave(root, patch, undefined, async key => { expect(key).toBe("tt_synthetic"); });
    expect(accepted.status).toBe(200);
    const activation = await configSave(root, JSON.stringify({integrations:[{name:"that-tracks",enabled:true,activate:true,remember:"Remember tracked events"}]}), undefined, async () => {});
    expect(activation.status).toBe(200);
    const rows = integrationsInfo(root, loadManifest(root)) as any[];
    const tracks = rows.find(r => r.name === "that-tracks");
    expect(tracks).toMatchObject({ enabled: true, hasCode: true, hasTrigger: true, status: { state: "waiting" } });
    expect(tracks.env).toEqual([{ env: "THAT_TRACKS_API_KEY", label: "api key", secret: true, set: true }]);
    expect(JSON.stringify(rows)).not.toContain("tt_synthetic");
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).not.toContain("tt_synthetic");
  });
  test("enabling without a key fails; disabling needs no network", async () => {
    const root = vault();
    expect((await configSave(root, JSON.stringify({ integrations: [{ name: "that-tracks", enabled: true }] }), undefined,
      async () => { throw new Error("must not probe"); })).status).toBe(400);
    expect((await configSave(root, JSON.stringify({ integrations: [{ name: "that-tracks", enabled: false }] }), undefined,
      async () => { throw new Error("must not probe"); })).status).toBe(200);
  });
});

test("retired capture cannot be re-enabled from a stale settings client", async () => {
  const root = vault();
  writeFileSync(join(root, "vault.yaml"), "integrations:\n  agent-chat:\n    enabled: false\n");
  const before = readFileSync(join(root, "vault.yaml"), "utf8");
  const result = await configSave(root, JSON.stringify({ integrations: [{ name: "agent-chat", enabled: true }] }));
  expect(result.status).toBe(400);
  expect(JSON.parse(result.body).error).toContain("retired");
  expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
});
