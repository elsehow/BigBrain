/** quick.ts — one bounded call to the vault's Quick model: what the memo
 * stages (lib/stages/briefing.ts, lib/stages/relation.ts) and a few
 * operational namers ask through. */
import type { BriefingClientOptions } from "../briefingTypes";
import { loadManifest } from "../manifest";
import { runAgent } from "../run/agent";

export interface BriefingModelTiming {
  totalMs: number; initMs?: number; firstTextMs?: number; apiMs?: number; inputTokens?: number; outputTokens?: number; turns?: number;
}
export type BriefingModel = (root: string, prompt: string, preview: (text: string) => void, system?: string, options?: BriefingClientOptions) => Promise<{ text: string; model: string; costUsd?: number; timing?: BriefingModelTiming }>;

export const runBriefingModel: BriefingModel = async (root, prompt, preview, system = "", options) => {
  const started = performance.now();
  const manifest = loadManifest(root), quick = manifest.quick;
  let firstTextMs: number | undefined;
  const result = await runAgent({ root, role: "quick", auth: manifest.auth,
    target: quick,
    capabilities: "none", instructions: system, prompt,
    timeoutMs: options?.timeoutMs ?? 60_000, signal: options?.signal,
    output: { requireText: true, schema: options?.outputSchema, maxTokensHint: options?.maxOutputTokens ?? 2000,
      maxCharacters: (options?.maxOutputTokens ?? 2000) * 8, maxBudgetUsd: options?.maxBudgetUsd },
    onText: text => { firstTextMs ??= performance.now() - started; preview(text); },
  });
  preview(result.text);
  return { text: result.text, model: quick.model, ...(result.usage?.cost_usd != null ? { costUsd: result.usage.cost_usd } : {}),
    timing: { totalMs: performance.now() - started, firstTextMs, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens, turns: result.usage?.turns } };

};
