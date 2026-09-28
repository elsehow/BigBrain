/** Stored effort is provider-native. Absence means the role's existing default. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export function validateReasoning(agent: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const choices: readonly string[] = agent === "pi" ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] : agent === "claude" ? CLAUDE_EFFORTS : CODEX_EFFORTS;
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`Unsupported ${agent} reasoning effort: ${String(value)}`);
  return value;
}
