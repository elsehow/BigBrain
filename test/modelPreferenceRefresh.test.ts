import { modelRecommendations } from "../lib/modelRecommendations";
import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { modelPreferences, refreshModelPreferences, setModelPreference } from "../lib/modelPreferenceRefresh";
import { applyConfig } from "../lib/config";
import { loadManifest } from "../lib/manifest";
import { readEnvValues, writeEnvValues } from "../lib/envFile";
import type { CurationAgent } from "../lib/modelCatalog";
import { gitVault } from "./support/vault";

const claude: CurationAgent = { id: "pi/anthropic", label: "Claude", ready: true,
  models: [{ id: "claude-opus-5", label: "Opus" }, { id: "claude-haiku-4-5", label: "Haiku" }] };
const openai: CurationAgent = { id: "pi/openai-codex", billing: "subscription", label: "ChatGPT", ready: true,
  models: [{ id: "gpt-6-astra", label: "Astra", reasoning: ["low", "medium", "high"] }] };

test("unconfigured roles follow recommendations; manual subscription selections stay pinned through reconnects", () => {
  const root = gitVault({ files: { "vault.yaml": "auth: max\n" } });
  try {
    expect(Object.values(modelPreferences(root))).toEqual(Array(4).fill("recommended"));
    refreshModelPreferences(root, [claude]);
    expect(loadManifest(root).quick.model).toBe("claude-haiku-4-5");
    applyConfig({ quick: { adapter: "pi", provider: "anthropic", model: "claude-opus-5", reasoning: "high" } }, root);
    for (const catalog of [[claude], [claude, openai], [openai], [], [claude]]) {
      refreshModelPreferences(root, catalog);
      expect(loadManifest(root).quick).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-opus-5", reasoning: "high" });
      expect(modelPreferences(root).quick).toBe("pinned");
    }
    refreshModelPreferences(root, [openai]);
    expect(loadManifest(root).gardener).toEqual({ adapter: "pi", provider: "openai-codex", model: "gpt-6-astra", reasoning: "medium" });
    setModelPreference(root, "quick", "recommended", [openai]);
    expect(loadManifest(root).quick.reasoning).toBe("low");
    refreshModelPreferences(root, [claude]);
    expect(loadManifest(root).quick).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-haiku-4-5" });
    expect(modelPreferences(root).quick).toBe("recommended");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy choices have unknown intent: load pins them without rewriting the vault", () => {
  const yaml = "auth: max\ncuration: { agent: codex, model: custom-fixture }\n";
  const root = gitVault({ files: { "vault.yaml": yaml } });
  try {
    writeEnvValues(root, { BIGBRAIN_PILOT_BACKEND: JSON.stringify({ adapter: "pi", provider: "anthropic", model: "fable" }) });
    expect(Object.values(modelPreferences(root))).toEqual(Array(4).fill("pinned"));
    refreshModelPreferences(root, [claude, openai]);
    expect(readFileSync(`${root}/vault.yaml`, "utf8")).toBe(yaml);
    expect(loadManifest(root).gardener.model).toBe("custom-fixture");
    expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_BACKEND!).model).toBe("fable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("API selections are pinned; recommendations never introduce API spending", () => {
  const root = gitVault({ files: { "vault.yaml": "auth: max\n" } });
  try {
    const choice = { adapter: "pi", provider: "openai", model: "fixture-api" };
    applyConfig({ gardener: choice, memory: choice }, root);
    writeEnvValues(root, { BIGBRAIN_PILOT_BACKEND: JSON.stringify(choice) });
    for (const catalog of [[claude], [claude, openai], [], [openai]]) {
      refreshModelPreferences(root, catalog);
      expect(loadManifest(root).gardener).toEqual(choice);
      expect(loadManifest(root).memory).toMatchObject(choice);
      expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_BACKEND!)).toEqual(choice);
    }
    const api = [{ ...openai, id: "pi/openai", billing: "api" as const }];
    expect(() => setModelPreference(root, "memory", "recommended", api)).toThrow("subscription");
    expect(modelPreferences(root).memory).toBe("pinned");
    setModelPreference(root, "pilot", "recommended", [claude]);
    expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_BACKEND!)).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-opus-5" });
    setModelPreference(root, "pilot", "pinned", []);
    refreshModelPreferences(root, [openai]);
    expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_BACKEND!).provider).toBe("anthropic");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("discovery failure or no eligible provider preserves the last recommended choice", () => {
  const root = gitVault({ files: { "vault.yaml": "auth: max\n" } });
  try {
    refreshModelPreferences(root, [claude]);
    const yaml = readFileSync(`${root}/vault.yaml`, "utf8"), env = readEnvValues(root);
    for (const catalog of [[], [{ ...claude, problem: "catalog failed" }, openai]]) {
      refreshModelPreferences(root, catalog);
      expect(readFileSync(`${root}/vault.yaml`, "utf8")).toBe(yaml);
      expect(readEnvValues(root)).toEqual(env);
    }
    expect(() => setModelPreference(root, "quick", "invalid", [claude])).toThrow();
    expect(() => setModelPreference(root, "unknown" as never, "pinned", [claude])).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recommendations use connection billing and choose eligible models per role", () => {
  const root = gitVault({ files: { "vault.yaml": "auth: api\n" } });
  try {
    setModelPreference(root, "quick", "recommended", [claude]);
    expect(loadManifest(root).quick.provider).toBe("anthropic");
    const restricted = { ...openai, models: [
      { id: "gpt-6-astra", label: "Restricted", capabilities: { tools: false } },
      { id: "tool-fixture", label: "Tools" },
    ] };
    setModelPreference(root, "gardener", "recommended", [claude, restricted]);
    expect(loadManifest(root).gardener).toEqual({ adapter: "pi", provider: "openai-codex", model: "tool-fixture" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("new-vault template declares automatic preference intent explicitly", () => {
  const root = gitVault({ files: { "vault.yaml": readFileSync(new URL("../vault.example.yaml", import.meta.url), "utf8") } });
  try {
    expect(Object.values(modelPreferences(root))).toEqual(Array(4).fill("recommended"));
    refreshModelPreferences(root, [openai]);
    expect(loadManifest(root).gardener.provider).toBe("openai-codex");
    expect(loadManifest(root).memory.provider).toBe("openai-codex");
    expect(loadManifest(root).quick.provider).toBe("openai-codex");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("recommended Claude roles prefer Pi when both runtimes are connected, regardless of catalog order", () => {
  const piClaude = { id: "pi/anthropic", label: "Claude", ready: true, billing: "subscription" as const,
    models: [{ id: "claude-opus-5", label: "Opus" }, { id: "claude-haiku-4-5", label: "Haiku" }] };
  for (const catalog of [[claude, piClaude], [piClaude, claude]]) {
    const result = modelRecommendations(catalog);
    expect(result.pilot).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-opus-5" });
    expect(result.quick).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-haiku-4-5" });
  }
});
