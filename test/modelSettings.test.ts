import { expect, test } from "bun:test";
import { changeModel, latestModels, reasoningOptions, type ModelAgent } from "../web/ui/src/lib/modelSettings";
import { fakePi } from "./support/pi";
import { runAgent } from "../lib/run/agent";
import { nativeVault } from "./support/vault";
import { rmSync } from "node:fs";
const agents: ModelAgent[] = [
  { id: "pi/anthropic", label: "Claude", ready: true, models: [{ id: "opus", label: "Opus", reasoning: ["low", "medium", "high"] }] },
  { id: "pi/openai-codex", label: "Codex", ready: true, models: [{ id: "example", label: "Example", reasoning: ["low", "high", "xhigh"] }] },
];
test("model changes preserve supported effort, reset incompatible effort, and honor live model metadata", () => {
  expect(changeModel(agents, { adapter: "pi", provider: "anthropic", model: "opus", reasoning: "high" }, "pi/openai-codex:example")).toEqual({ adapter: "pi", provider: "openai-codex", model: "example", reasoning: "high" });
  expect(changeModel(agents, { adapter: "pi", provider: "openai-codex", model: "example", reasoning: "xhigh" }, "pi/anthropic:opus")).toEqual({ adapter: "pi", provider: "anthropic", model: "opus" });
  expect(reasoningOptions(agents, { adapter: "pi", provider: "openai-codex", model: "example" })).toEqual(["low", "high", "xhigh"]);
  expect(reasoningOptions(agents, { adapter: "pi", provider: "openai-codex", model: "unknown" })).toEqual([]);
});
test("menus offer the newest model of each family and keep a saved older choice", () => {
  const ids = ["claude-lark-4-5", "claude-lark-4-5-20250101", "claude-lark-4-10", "claude-lark-5", "claude-wren-3-9", "claude-wren-4",
    "gpt-4.9", "gpt-5", "gpt-5.1-mini", "gpt-5.10-mini", "gpt-4o", "gpt-4o-2024-01-01", "o3", "o4-mini", "o3-mini", "fixture"];
  const models = ids.map(id => ({ id, label: id === "claude-lark-4-5" ? "Lark 4.5 (latest)" : id }));
  expect(latestModels(models).map(m => m.id)).toEqual(["claude-lark-5", "claude-wren-4", "gpt-5", "gpt-5.10-mini", "gpt-4o", "o3", "o4-mini", "fixture"]);
  expect(latestModels(models, "claude-lark-4-5").map(m => [m.id, m.label])).toContainEqual(["claude-lark-4-5", "Lark 4.5"]);
  expect(latestModels(models.filter(m => m.id.startsWith("claude-lark-4-5"))).map(m => m.id)).toEqual(["claude-lark-4-5"]);
});
test("Pi execution receives the saved reasoning flag", async () => {
  const root = nativeVault();
  try {
    let effort: string | undefined;
    await runAgent({ root, role: "tend", auth: "max", target: { adapter: "pi", provider: "anthropic", model: "claude-opus-5", reasoning: "high" }, capabilities: "gardener", prompt: "fixture", timeoutMs: 1000 },
      fakePi((_prompt, options) => { effort = options.thinkingLevel; return {}; }));
    expect(effort).toBe("high");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Quick defaults to reasoning off, preserves explicit effort, and leaves other roles alone", async () => {
  const root = nativeVault();
  try {
    for (const [role, reasoning, expected] of [["quick", undefined, "off"], ["quick", "high", "high"], ["memory", undefined, undefined]] as const) {
      let effort: string | undefined;
      await runAgent({ root, role, auth: "max", target: { adapter: "pi", provider: "anthropic", model: "claude-haiku-4-5", reasoning },
        capabilities: role === "quick" ? "none" : "memory", prompt: "fixture", timeoutMs: 2000 },
      fakePi((_prompt, options) => { effort = options.thinkingLevel; return { result: "Ready" }; }));
      expect(effort).toBe(expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
