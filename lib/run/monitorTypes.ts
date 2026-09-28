/** Provider-neutral observations. Counts are disjoint: input excludes cache reads/writes.
 * A sample is a replacement snapshot for its ID, never an implicit increment. */
export interface UsageSample {
  kind: "usage";
  /** Observation metadata; absent on older journals. */
  at?: string;
  accountId?: string | null;
  id: string;
  /** A turn-level SDK total can include auxiliary models. */
  models: string[];
  scope: "request" | "turn";
  /** Counts can be known lower bounds when a multi-model report is incomplete. */
  partial?: boolean;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  estimatedCostUsd: number | null;
}
export interface QuotaSample {
  kind: "quota";
  at?: string;
  accountId?: string | null;
  window: string;
  used: number;
  resetsAt: string;
}
export type ModelObservation = UsageSample | QuotaSample;
export type RunPhase = "preparing" | "running" | "waiting_for_tools" | "completed" | "failed" | "cancelled";
export interface RunRecord {
  version: 1;
  id: string;
  parentId?: string;
  role: string;
  provider: string;
  adapter: string;
  model: string;
  accountId: string | null;
  sessionId: string | null;
  transport: "subscription" | "api";
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  phase: RunPhase;
  lifecycle: { phase: RunPhase; at: string }[];
  samples: UsageSample[];
  quota: (QuotaSample & { at: string })[];
}
export interface RoleUsage {
  role: string;
  runs: number;
  measuredRuns: number;
  tokens: number;
  partial: boolean;
}
export interface ProviderMonitor {
  provider: string;
  since: string;
  asOf: string | null;
  capabilities: { tokens: boolean; quota: boolean };
  roles: RoleUsage[];
  accountIdentity: "known" | "unknown" | "multiple";
  quota: { state: "unsupported" | "unavailable" | "current" | "stale"; windows: {
    window: string; used: number; resetsAt: string; asOf: string; stale?: boolean;
  }[] };
}
