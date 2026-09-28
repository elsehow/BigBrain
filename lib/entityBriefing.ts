/** Bounded evidence and model execution shared by note briefings. */
import type { ProjectedEntityAssertion, ProjectedEntityView } from "./assertionEntityView";
import type { BriefingClientOptions } from "./briefingTypes";
import { loadManifest } from "./manifest";
import { runAgent } from "./run/agent";
const MAX_CHARS = 24_000;

/** Recent evidence gets half the budget; spread the rest across the history.
 * Whole assertions only. The displayed coverage makes omissions explicit. */
export function briefingEvidence(view: ProjectedEntityView): ProjectedEntityAssertion[] {
  const rows = [...view.assertions].filter(a => a.sources.length).sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const chosen = new Set<ProjectedEntityAssertion>();
  let used = 0;
  const size = (row: ProjectedEntityAssertion) => JSON.stringify(row).length;
  for (const row of [...rows].reverse()) {
    if (chosen.size >= 40 || used + size(row) > MAX_CHARS / 2) break;
    chosen.add(row); used += size(row);
  }
  const older = rows.filter(row => !chosen.has(row));
  // Evenly spaced candidates retain background on large nodes.
  const count = Math.min(40, older.length);
  for (let i = 0; i < count; i++) {
    const row = older[Math.floor(i * older.length / count)]!;
    if (used + size(row) > MAX_CHARS) continue;
    chosen.add(row); used += size(row);
  }
  return rows.filter(row => chosen.has(row));
}

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
