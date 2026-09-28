/** Text Pilot performance limits and timeouts live HERE; product dormancy and
 * ingestion timings remain in pilotLifecycleConfig.ts. */
export const PILOT_RUNTIME = {
  reasoning: "low",
  warmIdleMs: 10 * 60_000,
  maxWarmSessions: 4,
  interruptGraceMs: 3_000,
  parallelReads: 4,
  streamSaveMs: 200,
  toolResultChars: 90_000,
} as const;
