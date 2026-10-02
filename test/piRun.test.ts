import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { applyConfig } from "../lib/config";
import { runAgent } from "../lib/run/agent";
import { runModel } from "../lib/run/model";
import { BACKGROUND_JOB_TIMEOUT_MS } from "../lib/run/sessionJob";
import { readModelRuns } from "../lib/run/monitor";
import type { Auth } from "../lib/manifest";
import type { ToolObserver } from "../lib/run/toolActivity";
import type { OutputRequirements } from "../lib/run/request";
import { modelRunJournalFields } from "../lib/run/journal";
import type { PiSDK } from "../lib/run/piSession";
import { nativeVault, insertion } from "./support/vault";
import { MEMORY_ROLE } from "../lib/memory";
import { dueIntakeIds } from "../lib/work";
import { loadManifest } from "../lib/manifest";
import { writeEnvValues } from "../lib/envFile";

/** Concise inputs for the fake Pi fixture below. */
interface JobOptions {
  root: string; role: string; model: string; provider?: string; prompt: string;
  noTools?: boolean; requireText?: boolean; timeoutMs?: number;
  onTool?: ToolObserver;
  effort?: string; onText?: (text: string) => void; signal?: AbortSignal;
  instructions?: string; output?: OutputRequirements; auth?: Auth;
}

function runPi(opts: JobOptions, load?: () => Promise<PiSDK>) {
  return runAgent({ ...opts, auth: opts.auth ?? "max", target: { adapter: "pi", provider: opts.provider, model: opts.model, reasoning: opts.effort },
    capabilities: opts.noTools ? "none" : opts.role === "tend" ? "gardener" : "memory", output: { ...opts.output, requireText: opts.requireText ?? opts.output?.requireText } }, load);
}

async function fixture(frames: any[][], provider = "openai-codex") {
  const item = insertion({ body: "Ada prefers concise notes." });
  const root = nativeVault({ insertions: [item], files: { "vault.yaml": "auth: max\ncuration:\n  agent: codex\n  model: legacy-model\n" } });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3600_000 }));
  if (provider !== "openai-codex") await credentials.modify(provider, async () => ({ type: "api_key", key: "fixture-not-a-real-key" }));
  const runtime = await pi.ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(root, "models.json"), allowModelNetwork: false });
  const model = runtime.getAvailableSnapshot().find(m => m.provider === provider)!;
  const contexts: any[] = [], dispatched: string[] = [];
  runtime.streamSimple = (m, context) => {
    expect(readModelRuns(root, "").some(r => r.phase === "running")).toBe(true);
    contexts.push(context); dispatched.push(m.provider);
    const content = frames.shift() ?? [{ type: "text", text: "Done." }];
    const message: AssistantMessage = { role: "assistant", content, api: m.api, provider: m.provider, model: m.id,
      usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: content.some(c => c.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); });
    return stream;
  };
  const load = async () => ({ ...pi, ModelRuntime: { create: async () => runtime } }) as unknown as PiSDK;
  return { root, model: model.id, load, contexts, dispatched, runtime, item, close: () => rmSync(root, { recursive: true, force: true }) };
}
const call = (name: string, args: any) => [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];
test("ChatGPT background jobs use Pi with role-scoped tools and machine identity before inference", async () => {
  const frames: any[][] = [];
  const f = await fixture(frames);
  try {
    frames.push(call("write_memory", { path: "memory/MEMORY.md", content: "Ada prefers concise notes.\n" }));
    const memory = await runPi({ root: f.root, provider: "openai-codex", role: MEMORY_ROLE, model: f.model, prompt: "Update memory", timeoutMs: 2000 }, f.load);
    expect(readFileSync(join(f.root, "memory/MEMORY.md"), "utf8")).toContain("Ada");
    expect(readModelRuns(f.root, "").some(r => r.sessionId === memory.sessionId)).toBe(true);
    expect(memory.usage).toMatchObject({ turns: 2, input_tokens: 20, cost_usd: null });
    expect(getCurrentTools(f.contexts[0].messages).map((t: any) => t.name)).not.toContain("bash");
    frames.push(call("read_note", { path: "memory/MEMORY.md" }));
    await runPi({ root: f.root, provider: "openai-codex", role: "tend", model: f.model, prompt: "Try to read memory", timeoutMs: 2000 }, f.load);
    expect(f.contexts.at(-1).messages.some((m: any) => m.role === "toolResult" && m.isError)).toBe(true);
    expect(getCurrentTools(f.contexts.at(-1).messages).map((t: any) => t.name)).not.toContain("write_memory");
    frames.push(call("write_memory", { path: "log/forbidden.md", content: "Forbidden" }));
    await runPi({ root: f.root, provider: "openai-codex", role: MEMORY_ROLE, model: f.model, prompt: "Try to write outside memory", timeoutMs: 2000 }, f.load);
    expect(f.contexts.at(-1).messages.some((m: any) => m.role === "toolResult" && m.isError)).toBe(true);
    await runPi({ root: f.root, provider: "openai-codex", role: "quick", model: f.model, prompt: "Summarize", noTools: true, timeoutMs: 2000 }, f.load);
    expect(getCurrentTools(f.contexts.at(-1).messages)).toHaveLength(0);
  } finally { f.close(); }
});
test("a dropped arrival is settled through Pi's gardener tools", async () => {
  const frames: any[][] = [], f = await fixture(frames);
  try {
    expect(dueIntakeIds(f.root)).toContain(f.item.id);
    frames.push(call("submit", { items: [{ submit: "assertion", text: "[[new:Ada]] prefers concise notes.", sources: [f.item.id], confidence: "direct" }] }));
    const activity: string[] = [];
    await runPi({ root: f.root, provider: "openai-codex", role: "tend", model: f.model, prompt: "Review the arrival", timeoutMs: 2000,
      onTool: event => activity.push(`${event.name}:${event.phase}`) }, f.load);
    expect(activity).toEqual(["submit:start", "submit:complete"]);
    expect(dueIntakeIds(f.root)).not.toContain(f.item.id);
  } finally { f.close(); }
});
test("all saved Codex roles migrate to Pi without changing model preferences", async () => {
  const f = await fixture([]);
  try {
    expect(loadManifest(f.root).gardener.adapter).toBe("pi");
    writeEnvValues(f.root, { BIGBRAIN_CHATGPT_CONNECTED: "1" });
    const m = loadManifest(f.root);
    expect([m.gardener.adapter, m.memory.adapter, m.quick.adapter]).toEqual(["pi", "pi", "pi"]);
    expect(m.gardener.model).toBe("legacy-model");
  } finally { f.close(); }
});
test("a Pi job deadline prevents dispatch after delayed initialization", async () => {
  const f = await fixture([]);
  try {
    await expect(runPi({ root: f.root, provider: "openai-codex", role: "quick", model: f.model, prompt: "Never dispatched", timeoutMs: 5, noTools: true }, async () => {
      await Bun.sleep(20); return f.load();
    })).rejects.toThrow();
    expect(f.contexts).toHaveLength(0);
  } finally { f.close(); }
});
test("background jobs, memory turns included, default to a 60-minute deadline", async () => {
  expect(BACKGROUND_JOB_TIMEOUT_MS).toBe(60 * 60_000);
  const f = await fixture([]);
  const timers = spyOn(globalThis, "setTimeout");
  try {
    await runModel({ root: f.root, role: MEMORY_ROLE, auth: "max", target: { adapter: "pi", provider: "openai-codex", model: f.model }, prompt: "Update memory" }, f.load);
    expect(timers.mock.calls.some(([, ms]) => ms === BACKGROUND_JOB_TIMEOUT_MS)).toBe(true);
  } finally { timers.mockRestore(); f.close(); }
});
test("tool-only background completion is valid; text-required jobs still reject an empty answer", async () => {
  const frames: any[][] = [[]];
  const f = await fixture(frames);
  try {
    const result = await runPi({ root: f.root, provider: "openai-codex", role: "tend", model: f.model, prompt: "Nothing more to say" }, f.load);
    expect(result.text).toBe("");
    frames.push([]);
    await expect(runPi({ root: f.root, provider: "openai-codex", role: "quick", model: f.model, prompt: "An answer is required", noTools: true, requireText: true }, f.load)).rejects.toThrow("without an answer");
  } finally { f.close(); }
});

test("Quick validates structured answers and enforces its host output bound", async () => {
  const frames: any[][] = [], f = await fixture(frames);
  const opts = { root: f.root, provider: "openai-codex", role: "quick", model: f.model, prompt: "Summarize", noTools: true, requireText: true,
    output: { schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false }, maxCharacters: 40 } };
  try {
    frames.push([{ type: "text", text: '{"summary":"Done"}' }]);
    expect((await runPi(opts, f.load)).text).toBe('{"summary":"Done"}');
    for (const fence of ["```json", "```"]) {
      frames.push([{ type: "text", text: fence + '\n{"summary":"Done"}\n```' }]);
      expect((await runPi(opts, f.load)).text).toBe('{"summary":"Done"}');
      expect(readModelRuns(f.root, "").filter(r => r.phase === "failed")).toHaveLength(0);
    }
    frames.push([{ type: "text", text: '```json\n{"summary":42}\n```' }]);
    await expect(runPi(opts, f.load)).rejects.toThrow("schema");
    for (const text of ['Here:\n```json\n{}\n```', '```json\n{}', '```json\n{}\n```\nextra']) {
      frames.push([{ type: "text", text }]);
      await expect(runPi(opts, f.load)).rejects.toThrow("invalid JSON");
    }
    frames.push([{ type: "text", text: '{"summary":42}' }]);
    await expect(runPi(opts, f.load)).rejects.toThrow("schema");
    frames.push([{ type: "text", text: 'Not JSON' }]);
    await expect(runPi(opts, f.load)).rejects.toThrow("invalid JSON");
    frames.push([{ type: "text", text: JSON.stringify({ summary: "x".repeat(50) }) }]);
    await expect(runPi(opts, f.load)).rejects.toThrow("character limit");
  } finally { f.close(); }
});
test("unsupported hard subscription token limits and cancelled jobs never dispatch", async () => {
  const f = await fixture([]);
  const opts = { root: f.root, provider: "openai-codex", role: "quick", model: f.model, prompt: "Never dispatched", noTools: true };
  try {
    await expect(runPi({ ...opts, output: { maxTokens: 20 } }, f.load)).rejects.toThrow("token");
    const controller = new AbortController(); controller.abort(new Error("Cancelled by caller"));
    await expect(runPi({ ...opts, signal: controller.signal }, f.load)).rejects.toThrow("Cancelled by caller");
    expect(f.contexts).toHaveLength(0);
  } finally { f.close(); }
});

test("ChatGPT can ignore a token hint while enforcing the portable hard character bound", async () => {
  const f = await fixture([[{ type: "text", text: "Ready" }]]);
  try {
    const result = await runPi({ root: f.root, provider: "openai-codex", role: "quick", model: f.model, prompt: "Reply briefly", noTools: true,
      output: { maxTokensHint: 20, maxCharacters: 40 } }, f.load);
    expect(result.text).toBe("Ready");
    expect(f.contexts).toHaveLength(1);
  } finally { f.close(); }
});


test("API model choices survive save/read and dispatch on their exact provider, including accounting", async () => {
  const f = await fixture([], "openai");
  try {
    spawnSync("git", ["init", "-q"], { cwd: f.root });
    const choice = { adapter: "pi", provider: "openai", model: f.model };
    applyConfig({ gardener: choice, memory: choice }, f.root);
    const manifest = loadManifest(f.root);
    for (const role of ["gardener", "memory"] as const) {
      expect(manifest[role]).toMatchObject(choice);
      const result = await runAgent({ root: f.root, role, auth: "max", target: manifest[role], capabilities: role, prompt: "Fixture", timeoutMs: 2000 }, f.load);
      expect(modelRunJournalFields(result)).toMatchObject({ engine: "pi", sampling: "pi-defaults", adapter: "pi", provider: "openai", model: f.model, transport: "api" });
    }
    expect(f.dispatched).toEqual(["openai", "openai"]);
    expect(readModelRuns(f.root, "")).toHaveLength(2);
    expect(readModelRuns(f.root, "").every(run => run.provider === "openai" && run.transport === "api")).toBe(true);
    // A model-only edit must not silently reset an API choice to Claude.
    applyConfig({ gardener: { model: f.model } }, f.root);
    expect(loadManifest(f.root).gardener).toEqual(choice);
  } finally { f.close(); }
});

test("legacy Pi choices normalize once on read and never rewrite the vault", async () => {
  const f = await fixture([]);
  try {
    const before = readFileSync(join(f.root, "vault.yaml"), "utf8");
    const manifest = loadManifest(f.root);
    expect(manifest.gardener).toEqual({ adapter: "pi", provider: "openai-codex", model: "legacy-model" });
    await runAgent({ root: f.root, role: "gardener", auth: "max", target: { ...manifest.gardener, model: f.model }, capabilities: "gardener", prompt: "Fixture", timeoutMs: 2000 }, f.load);
    expect(f.dispatched).toEqual(["openai-codex"]);
    expect(readFileSync(join(f.root, "vault.yaml"), "utf8")).toBe(before);
    await expect(runPi({ root: f.root, role: "tend", model: f.model, prompt: "Missing provider" }, f.load)).rejects.toThrow("Choose a Pi provider");
  } finally { f.close(); }
});

test("unavailable API provider and Quick's unsupported budget fail before dispatch", async () => {
  const f = await fixture([], "openai");
  try {
    const request = { root: f.root, role: "quick", auth: "max" as const, target: { adapter: "pi", provider: "openai", model: f.model }, capabilities: "none" as const, prompt: "Fixture", output: { maxBudgetUsd: 0.15 } };
    await expect(runAgent(request, f.load)).rejects.toThrow("spending limit");
    await expect(runAgent({ ...request, role: "gardener", capabilities: "gardener", target: { ...request.target, provider: "fixture-unconnected" } }, f.load)).rejects.toThrow("Connect fixture-unconnected");
    expect(f.dispatched).toEqual([]);
  } finally { f.close(); }
});

test("live model restrictions are checked before any tool or inference call", async () => {
  const f = await fixture([]);
  try {
    const original = f.runtime.getModel.bind(f.runtime);
    f.runtime.getModel = ((...args: Parameters<typeof original>) => ({ ...original(...args), capabilities: { tools: false } })) as typeof f.runtime.getModel;
    await expect(runAgent({ root: f.root, role: "gardener", auth: "max", target: { adapter: "pi", provider: "openai-codex", model: f.model },
      capabilities: "gardener", prompt: "Fixture" }, f.load)).rejects.toThrow("tool calls");
    expect(f.dispatched).toEqual([]);
    expect(readModelRuns(f.root, "")[0]!.phase).toBe("failed");
  } finally { f.close(); }
});
