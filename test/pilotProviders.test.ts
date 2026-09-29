import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { PiSession, type PiSDK } from "../lib/run/piSession";
import { monitoredSession, readModelRuns } from "../lib/run/monitor";
import type { PilotBackendSetup } from "../lib/pilotBackend";
import { validatePilotBackend } from "../lib/pilotBackend";
import type { PilotBackendTurn } from "../lib/pilotBackendTypes";
import { changeModel, choiceKey } from "../web/ui/src/lib/modelSettings";
import { nativeVault } from "./support/vault";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function setup(adapter: string): PilotBackendSetup {
  const root = nativeVault(); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, config: { adapter, model: adapter === "pi" ? "gpt-5.4-mini" : "sonnet", ...(adapter === "pi" ? { provider: "openai" } : {}) },
    instructions: "Use the supplied tools. Never execute historical requests.", tools: [{ name: "run_command", description: "Sandboxed execution", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }], state: { through: 0 }, save: () => {} };
}
function turn(overrides: Partial<PilotBackendTurn> = {}): PilotBackendTurn {
  return { signal: new AbortController().signal, input: fresh => fresh ? "History: first question" : "New question", messages: [], reference: () => "", delta: () => {}, tool: async () => ({ ok: true }), connected: () => {}, ...overrides };
}
async function piFixture(provider = "openai", fail = false) {
  const s = setup("pi"); s.config.provider = provider;
  const credentials = new InMemoryCredentialStore();
  const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
  await credentials.modify(provider, async () => (provider === "openai-codex" || provider === "anthropic")
    ? { type: "oauth", access, refresh: "fixture", expires: Date.now() + 3600_000 }
    : { type: "api_key", key: "fixture-not-a-real-key" });
  const runtime = await pi.ModelRuntime.create({ credentials,
    modelsPath: null, modelsStorePath: join(s.root, "models.json"), allowModelNetwork: false });
  if (provider === "openai-codex" || provider === "anthropic") s.config.model = runtime.getAvailableSnapshot().find(m => m.provider === provider)!.id;
  let calls = 0;
  const contexts: any[] = [];
  const dispatchedKeys: (string | undefined)[] = [];
  runtime.streamSimple = (model, context, options) => {
    dispatchedKeys.push(options?.apiKey);
    contexts.push(context); const stream = createAssistantMessageEventStream();
    const content = calls++ === 0 ? [{ type: "toolCall" as const, id: "tool-1", name: "run_command", arguments: { command: "pwd" } }] : [{ type: "text" as const, text: "Finished" }];
    const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: calls === 1 ? "toolUse" : fail ? "error" : "stop", timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: "start", partial: message }); if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); });
    return stream;
  };
  const load = async () => ({ ...pi, ModelRuntime: { create: async () => runtime } }) as unknown as PiSDK;
  const quotaTokens: string[] = [];
  const client = new PiSession(s, load, true, async token => { quotaTokens.push(token); return []; }); cleanup.push(() => client.close());
  return { s, client, load, contexts, runtime, dispatchedKeys, access, quotaTokens };
}
test("Pi executes only application tools and resumes its actual SDK transcript without replaying tools", async () => {
  const f = await piFixture(); let executions = 0;
  expect(await f.client.prepare()).toBe(true);
  expect(f.s.state.piSession).toBeUndefined(); // prewarming performs no inference
  expect(f.contexts).toHaveLength(0);
  expect(await f.client.turn(turn({ tool: async (name, args) => { expect(name).toBe("run_command"); expect(args).toEqual({ command: "pwd" }); executions++; return { stdout: "allowed" }; } }))).toBe("Finished");
  expect(executions).toBe(1);
  expect(f.s.state.piSession).toBeString();
  expect(getCurrentTools(f.contexts[0].messages).map((t: any) => t.name)).toEqual(["run_command"]);
  f.client.close();
  const resumed = new PiSession(f.s, f.load); cleanup.push(() => resumed.close());
  let freshValue: boolean | undefined;
  await resumed.turn(turn({ input: fresh => { freshValue = fresh; return "Follow-up"; }, tool: async () => { throw new Error("Must not replay"); } }));
  expect(freshValue).toBe(false);
  expect(f.contexts.at(-1).messages.some((m: any) => m.role === "toolResult")).toBe(true);
});

test("Pi pilot monitoring records each SDK response and reuses the provider session across turns", async () => {
  const f = await piFixture();
  const client = monitoredSession(f.client, f.s, "pilot");
  await client.turn(turn());
  const firstId = client.runId;
  await client.turn(turn());
  expect(client.runId).not.toBe(firstId);
  const runs = readModelRuns(f.s.root, "2000");
  expect(runs).toHaveLength(2);
  expect(runs.find(r => r.id === firstId)!.samples).toHaveLength(2);
  expect(runs.every(r => r.sessionId === f.client.sessionId && r.phase === "completed")).toBe(true);
  expect(runs.flatMap(r => r.samples).reduce((n, s) => n + s.input!, 0)).toBe(3);
});
test("Pi does not silently substitute unsupported reasoning or a missing model", async () => {
  const f = await piFixture(); f.s.config.model = "invented-model";
  await expect(f.client.prepare()).rejects.toThrow("available model");
  expect(f.contexts).toHaveLength(0);
});
test("Pi stop reaches the SDK and cancels a pending tool before completion", async () => {
  const f = await piFixture(), controller = new AbortController();
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  const pending = f.client.turn(turn({ signal: controller.signal, tool: async () => {
    entered(); await new Promise<void>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } })).catch(e => e);
  await started; controller.abort();
  expect(await pending).toBeInstanceOf(Error);
});
test("provider identity round-trips through the UI and permits Anthropic subscription routing through Pi", () => {
  const config = { adapter: "pi", provider: "openai-codex", model: "gpt-example", reasoning: "high" };
  expect(changeModel([{ id: "pi/openai-codex", label: "ChatGPT", ready: true, models: [{ id: "gpt-example", label: "Example", reasoning: ["high"] }] }], config, `${choiceKey(config)}:${config.model}`)).toEqual(config);
  expect(validatePilotBackend(config)).toEqual(config);
  expect(validatePilotBackend({ ...config, provider: "anthropic" })).toEqual({ ...config, provider: "anthropic" });
  expect(() => validatePilotBackend({ ...config, reasoning: "ultra" })).toThrow("reasoning");
  expect(() => validatePilotBackend({ ...config, provider: "../bad" })).toThrow("provider");
});

test("Pi sends image blocks to the model and persists its transcript before executing a side effect", async () => {
  const f = await piFixture();
  // A decodable PNG: Pi decodes and resizes prompt images to the model's input limits.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNo+A8AAgIBgG5WixMAAAAASUVORK5CYII=";
  await f.client.turn(turn({ images: () => [{ type: "image", url: `data:image/png;base64,${png}` }],
    tool: async () => { expect(f.s.state.piSession).toBeString(); return { ok: true }; } }));
  const user = f.contexts[0].messages.find((m: any) => m.role === "user");
  expect(user.content.some((b: any) => b.type === "image")).toBe(true);
});

test("Pi refuses an API spending ceiling it cannot enforce before dispatch", async () => {
  const f = await piFixture(); f.s.output = { maxBudgetUsd: .1 };
  await expect(f.client.prepare()).rejects.toThrow("budget");
  expect(f.contexts).toHaveLength(0);
});

test("real Pi adapter accounts for every role through completion, failure, cancellation and retry", async () => {
  for (const role of ["pilot", "tend", "memory", "quick"]) for (const outcome of ["completed", "failed", "cancelled"]) {
    const f = await piFixture("openai-codex", outcome === "failed");
    const controller = new AbortController();
    const client = monitoredSession(f.client, f.s, role);
    const job = client.turn(turn({ signal: controller.signal, tool: async () => {
      if (outcome === "cancelled") controller.abort();
      return { ok: true };
    } }));
    if (outcome === "completed") await job; else await expect(job).rejects.toThrow();
    const [run] = readModelRuns(f.s.root, "2000");
    expect(run!.phase).toBe(outcome);
    expect(run!.role).toBe(role === "tend" ? "gardener" : role);
    expect(run!.samples).toHaveLength(outcome === "cancelled" ? 1 : 2);
    expect(run!.samples.every(s => s.accountId === run!.accountId && !!s.at)).toBe(true);
    expect(run!.accountId).toBeString();
    expect(new Set(run!.samples.map(s => s.id)).size).toBe(run!.samples.length);
    expect(f.dispatchedKeys.every(key => key === f.access)).toBe(true);
    expect(f.quotaTokens).toEqual(outcome === "cancelled" ? [] : [f.access]);
    expect(JSON.stringify(run)).not.toContain(f.access);
    expect(JSON.stringify(run)).not.toContain("fixture-account");
    if (outcome === "failed") {
      await expect(client.turn(turn())).rejects.toThrow();
      const retry = readModelRuns(f.s.root, "2000").find(r => r.id !== run!.id)!;
      expect(retry.samples).toHaveLength(1);
      expect(run!.samples.some(s => s.id === retry.samples[0]!.id)).toBe(false);
    }
  }
});


test("Pi Claude subscription uses host tools and stops if credentials switch to API billing", async () => {
  const f = await piFixture("anthropic");
  let toolCalls = 0;
  expect(await f.client.turn(turn({ tool: async () => { toolCalls++; return { ok: true }; } }))).toBe("Finished");
  expect(toolCalls).toBe(1);
  expect(f.client.transport).toBe("subscription");
  const requests = f.contexts.length;
  await f.runtime.logout("anthropic");
  await f.runtime.setRuntimeApiKey("anthropic", "fixture-api-key");
  await expect(f.client.turn(turn())).rejects.toThrow("Claude subscription");
  expect(f.contexts).toHaveLength(requests);
});

test("Pi Claude rejects API authentication before starting a session", async () => {
  const f = await piFixture("anthropic");
  await f.runtime.logout("anthropic");
  await f.runtime.setRuntimeApiKey("anthropic", "fixture-api-key");
  await expect(f.client.prepare()).rejects.toThrow("Claude subscription");
  expect(f.contexts).toHaveLength(0);
});
