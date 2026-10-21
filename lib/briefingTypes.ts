/** Provider-neutral requirements for a brief answer. Output size is enforced
 * in characters (8 per requested token); provider token limits are not portable. */
export interface BriefingClientOptions {
  maxOutputTokens: number; maxBudgetUsd: number; timeoutMs?: number;
  outputSchema?: Record<string, unknown>; signal?: AbortSignal;
  /** Drop queued work when its last reader leaves, without discarding an active answer. */
  queueSignal?: AbortSignal;
}
