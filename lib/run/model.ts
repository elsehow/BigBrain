/** Background model dispatch and journal accounting. */
import { runAgent } from "./agent";
import type { PiSDK } from "./piSession";
import type { Auth } from "../manifest";
import type { ModelChoice } from "../modelChoice";
import { executionJournalFields } from "../modelResolution";
import type { RunMeter } from "../meterTypes";
/** Stable journal labels, including historical Claude CLI records. */
export type QueueEngine = "claude-code" | "claude-cli" | "codex" | "pi";

export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  cost_usd: number | null;
}

export interface AgentRunResult {
  execution?: import("../modelResolution").ModelExecution;
  runId?: string;
  text: string;
  sessionId: string;
  wallMs: number;
  usage?: RunUsage;
  meter?: RunMeter;
}

export interface ModelRunResult {
  execution?: import("../modelResolution").ModelExecution;
  runId?: string;
  text: string;
  /** Pi session identity, separate from public application history. */
  sessionId?: string;
  engine: QueueEngine;
  sampling: string;
  usage?: RunUsage;
  /** The plan meter before/after the run (subscription auth only). */
  meter?: RunMeter;
}

export interface RunModelOpts {
  memoryEdits?: import("../memoryEdits").MemoryEdits;
  target: ModelChoice;
  prompt: string;
  root: string;
  role: string;
  auth: Auth;
  /** Answer only from the supplied prompt, with no host tools. */
  noTools?: boolean;
}

export async function runModel(opts: RunModelOpts, loadPi?: () => Promise<PiSDK>): Promise<ModelRunResult> {
  const run = await runAgent({
    root: opts.root, role: opts.role, auth: opts.auth, prompt: opts.prompt,
    target: opts.target, memoryEdits: opts.memoryEdits,
    capabilities: opts.noTools ? "none" : "memory",
    timeoutMs: 1_200_000, output: { requireText: true },
  }, loadPi);
  const fields = executionJournalFields(run.execution!);
  return { ...run, engine: fields.engine as QueueEngine, sampling: fields.sampling as string };
}
