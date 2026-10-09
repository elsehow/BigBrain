import { expect, test } from "bun:test";
import { availableDefaults, preferredDefaults, MODEL_DEFAULTS } from "../lib/modelDefaults";

test("recommendations retain role reasoning only when the connected catalog supports it", () => {
  const defaults = availableDefaults("openai", [{ id: MODEL_DEFAULTS.openai.pilot.model, reasoning: ["low", "medium", "high"] }]);
  expect(defaults.quick.reasoning).toBe("low");
  expect(defaults.memory.reasoning).toBe("high");
  const limited = availableDefaults("openai", [{ id: "account-default", isDefault: true, reasoning: ["low"] }]);
  expect(limited.memory).toEqual({ model: "account-default" });
  expect(limited.quick).toEqual({ model: "account-default", reasoning: "low" });
  expect(() => availableDefaults("openai", [])).toThrow("No ChatGPT model");
});


test("gardener recommendation follows the shared provider order and falls back to connected providers", () => {
  expect(preferredDefaults({ openai: MODEL_DEFAULTS.openai, anthropic: MODEL_DEFAULTS.anthropic }).gardener)
    .toEqual({ provider: "openai", ...MODEL_DEFAULTS.openai.gardener });
  expect(preferredDefaults({ anthropic: MODEL_DEFAULTS.anthropic }).gardener)
    .toEqual({ provider: "anthropic", ...MODEL_DEFAULTS.anthropic.gardener });
  expect(preferredDefaults({})).toEqual({});
  const both = preferredDefaults({ openai: MODEL_DEFAULTS.openai, anthropic: MODEL_DEFAULTS.anthropic });
  expect(both.pilot?.provider).toBe("anthropic");
  expect(both.memory?.provider).toBe("anthropic");
  expect(both.quick?.provider).toBe("anthropic");
});


test("Claude recommendations resolve family aliases to the latest available native model", () => {
  const models = ["claude-fable-5", "claude-opus-4-9", "claude-opus-4-10-20260920", "claude-opus-4-10", "claude-haiku-4-5"];
  const defaults = availableDefaults("anthropic", models.map(id => ({ id })));
  expect(defaults.memory.model).toBe("claude-opus-4-10");
  expect(defaults.quick.model).toBe("claude-haiku-4-5");
  expect(availableDefaults("anthropic", [{ id: "opus" }, { id: "claude-opus-4-10" }]).pilot.model).toBe("opus");
});

test("the Claude Quick recommendation is the newest Haiku that can answer without thinking", () => {
  const thinking = ["low", "medium", "high"], optional = ["off", "minimal", ...thinking];
  const defaults = availableDefaults("anthropic", [
    { id: "claude-haiku-4-5", reasoning: optional }, { id: "claude-haiku-5-5", reasoning: thinking },
    { id: "claude-opus-5-5", reasoning: thinking }]);
  expect(defaults.quick).toEqual({ model: "claude-haiku-4-5", reasoning: "off" });
  expect(defaults.memory).toEqual({ model: "claude-opus-5-5" });
  expect(availableDefaults("anthropic", [{ id: "claude-haiku-5-5", reasoning: thinking }, { id: "claude-haiku-6", reasoning: optional }]).quick)
    .toEqual({ model: "claude-haiku-6", reasoning: "off" });
  // With no Haiku able to stop thinking, the newest still wins over another family.
  expect(availableDefaults("anthropic", [{ id: "claude-haiku-5-5", reasoning: thinking }, { id: "claude-opus-5-5", isDefault: true }]).quick)
    .toEqual({ model: "claude-haiku-5-5" });
});

test("the Claude gardener recommendation is the newest Sonnet; the other roles keep their families", () => {
  const models = ["claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-4-5"];
  const defaults = availableDefaults("anthropic", models.map(id => ({ id })));
  expect(defaults.gardener.model).toBe("claude-sonnet-5-5");
  expect([defaults.memory.model, defaults.pilot.model, defaults.quick.model]).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-haiku-4-5"]);
});
