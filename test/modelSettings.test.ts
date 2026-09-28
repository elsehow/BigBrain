import { expect, test } from "bun:test";
import { changeModel, reasoningOptions, type ModelAgent } from "../web/ui/src/lib/modelSettings";
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
