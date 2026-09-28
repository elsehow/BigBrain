import { validateReasoning } from "./reasoning";

/** Durable model identity, shared by interactive and background roles. */
export interface ModelChoice { adapter: "pi"; provider: string; model: string; reasoning?: string }
export const MODEL_ROLES = ["gardener", "memory", "quick", "pilot"] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export function modelRole(role: string): ModelRole {
  if (role === "tend") return "gardener";
  if (role === "probe") return "pilot";
  if (MODEL_ROLES.includes(role as ModelRole)) return role as ModelRole;
  throw new Error(`Unknown model role: ${role}`);
}
export type ModelPreference = "pinned" | "recommended";
export function modelPreference(value: unknown, fallback: ModelPreference): ModelPreference {
  if (value === undefined) return fallback;
  if (value !== "pinned" && value !== "recommended") throw new Error("Choose pinned or recommended model preferences.");
  return value;
}
export interface ModelCapabilities { tools: boolean; streaming: boolean; structuredOutput: boolean; budget: boolean }
export const ROLE_REQUIREMENTS: Record<ModelRole, readonly (keyof ModelCapabilities)[]> = {
  gardener: ["tools"], memory: ["tools"], quick: ["structuredOutput", "budget"], pilot: ["tools", "streaming"],
};
/** These are runtime guarantees, not ratings of a model's reasoning quality.
 * Structured output is host-validated; subscription jobs incur no API bill. */
export function sessionCapabilities(_adapter: string, billing: "subscription" | "api"): ModelCapabilities {
  return { tools: true, streaming: true, structuredOutput: true, budget: billing === "subscription" };
}
export function modelRoleProblem(role: ModelRole, capabilities: ModelCapabilities): string | undefined {
  const missing = ROLE_REQUIREMENTS[role].find(key => !capabilities[key]);
  if (!missing) return;
  if (missing === "budget") return "Quick requires an enforceable API spending limit. This runtime cannot enforce one.";
  return `${role} requires ${missing === "tools" ? "tool calls" : missing === "structuredOutput" ? "validated structured output" : "streaming"}.`;
}
export const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/;

export function validateModelChoice(value: unknown): ModelChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a model.");
  const c = value as ModelChoice;
  if (c.adapter !== "pi") throw new Error("Unsupported model adapter. Choose Pi.");
  if (typeof c.model !== "string" || !MODEL_ID.test(c.model)) throw new Error("Enter a provider-native model ID.");
  if (typeof c.provider !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(c.provider))
    throw new Error("Choose a Pi provider.");
  const reasoning = validateReasoning(c.adapter, c.reasoning);
  return { adapter: c.adapter, provider: c.provider, model: c.model, ...(reasoning ? { reasoning } : {}) };
}
/** Compatibility belongs at saved-config boundaries, never at dispatch. */
export function readModelChoice(value: { adapter?: string; agent?: string; provider?: string; model: string; reasoning?: string }): ModelChoice {
  if (value.adapter === "responses") return validateModelChoice({ ...value, adapter: "pi", provider: "openai", ...(value.reasoning === "none" ? { reasoning: "off" } : {}) });
  const legacy = value.adapter === undefined;
  const adapter = value.adapter ?? value.agent ?? "claude";
  if (adapter === "claude") return validateModelChoice({ adapter: "pi", provider: "anthropic", model: LEGACY_CLAUDE_MODELS[value.model] ?? value.model, reasoning: value.reasoning });
  return validateModelChoice({ ...value, adapter: adapter === "codex" ? "pi" : adapter,
    provider: value.provider ?? (adapter === "codex" || (legacy && adapter === "pi") ? "openai-codex" : undefined) });
}

/** Freeze former CLI aliases at the saved-state boundary; new choices use native IDs. */
export const LEGACY_CLAUDE_MODELS: Record<string, string> = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5", fable: "claude-fable-5-1" };
