import { PassThrough } from "node:stream";
import { gitVault } from "./support/vault";
import { modelPreferences } from "../lib/modelPreferenceRefresh";
import { loadManifest } from "../lib/manifest";
import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nativeVault } from "./support/vault";
import { modelCatalog, curationModels, type ModelSources } from "../lib/modelCatalog";
import { modelsForRole } from "../lib/modelSelection";
import { setupRoutes, type SetupState } from "../lib/firstRun";

const state = { claude: { installed: "test", account: "test", connected: true }, chatgpt: { connected: true } } as SetupState;
test("model discovery queries each provider once and curation uses the same catalog shape", async () => {
  let pi = 0;
  const read: ModelSources = {
    pi: async () => { pi++; return [{ id: "pi/openai-codex", label: "ChatGPT", ready: true, models: [{ id: "synthetic", label: "Synthetic" }] }]; },
  };
  const catalog = await modelCatalog(state, read);
  expect(pi).toBe(1);
  expect(catalog.map(p => p.id)).toEqual(["pi/openai-codex"]);
  expect((await curationModels(state, read)).map(p => p.id)).toEqual(["pi/openai-codex"]);
});

test("GET model settings leaves explicit preferences and provider bookkeeping unchanged", async () => {
  const root = nativeVault({ files: { "vault.yaml": "auth: max\n", ".env": 'BIGBRAIN_MODEL_PROVIDERS=anthropic\nBIGBRAIN_PILOT_BACKEND={"adapter":"claude","model":"fable"}\n' } });
  try {
    const before = ["vault.yaml", ".env"].map(file => readFileSync(join(root, file), "utf8"));
    const routes = setupRoutes({ root, state: () => state, onVault() {}, modelSources: {
      pi: async () => [{ id: "pi/openai-codex", label: "ChatGPT", ready: true, models: [{ id: "synthetic", label: "Synthetic" }] }],
    } });
    let response = "";
    await routes.find(r => r.path === "/api/agents/models")!.handler({ res: { writeHead() {}, end(body: string) { response = body; } } } as never);
    expect(JSON.parse(response).agents).toHaveLength(1);
    expect(JSON.parse(response).preferences.pilot).toBe("pinned");
    expect(JSON.parse(response).recommendations.gardener).toMatchObject({ adapter: "pi", provider: "openai-codex" });
    expect(["vault.yaml", ".env"].map(file => readFileSync(join(root, file), "utf8"))).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("all roles share providers; only declared capabilities constrain choices", async () => {
  const read: ModelSources = { pi: async () => [
    { id: "pi/openai", label: "OpenAI", billing: "api", ready: true, models: [{ id: "fixture", label: "Fixture" }] },
    { id: "pi/openai-codex", label: "ChatGPT", billing: "subscription", ready: true, models: [{ id: "fixture", label: "Fixture" }] },
  ] };
  const catalog = await curationModels(state, read);
  expect(catalog).toEqual(await modelCatalog(state, read));
  for (const role of ["gardener", "memory", "pilot"] as const)
    expect(modelsForRole(catalog, role).find(p => p.id === "pi/openai")?.models).toHaveLength(1);
  const quick = modelsForRole(catalog, "quick");
  expect(quick.find(p => p.id === "pi/openai")).toMatchObject({ ready: false, models: [], problem: expect.stringContaining("spending limit") });
  expect(quick.find(p => p.id === "pi/openai-codex")?.models).toHaveLength(1);
  const noTools = { id: "pi/fixture", label: "Fixture", ready: true, models: [{ id: "no-tools", label: "No tools", capabilities: { tools: false, streaming: true, structuredOutput: true, budget: true } }] };
  expect(modelsForRole([noTools], "gardener")[0]!.models).toEqual([]);
  expect(modelsForRole([noTools], "quick")[0]!.models).toHaveLength(1);
});

test("the preference endpoint persists policy and selection together, and rejects unavailable recommendations", async () => {
  const root = gitVault({ files: { "vault.yaml": "auth: max\ngardener: { adapter: claude, model: fable }\n" } });
  try {
    let ready = true;
    const routes = setupRoutes({ root, state: () => ({ ...state, claude: { ...state.claude, connected: ready } }), onVault() {},
      modelSources: { pi: async () => [{ id: "pi/anthropic", label: "Claude", ready, models: [{ id: "claude-opus-5", label: "Opus" }] }] } });
    const route = routes.find(r => r.path === "/api/models/preference")!;
    const post = async (body: unknown) => {
      let code = 0;
      const req = new PassThrough(), res = { writeHead(status: number) { code = status; }, end() {} };
      const work = route.handler({ req, res } as never); req.end(JSON.stringify(body)); await work; return code;
    };
    expect(await post({ role: "gardener", preference: "recommended" })).toBe(200);
    expect(loadManifest(root).gardener.model).toBe("claude-opus-5");
    expect(modelPreferences(root).gardener).toBe("recommended");
    expect(await post({ role: "gardener", preference: "pinned" })).toBe(200);
    ready = false;
    expect(await post({ role: "gardener", preference: "recommended" })).toBe(400);
    expect(modelPreferences(root).gardener).toBe("pinned");
    expect(loadManifest(root).gardener.model).toBe("claude-opus-5");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
