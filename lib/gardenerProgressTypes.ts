/** Local UI status: counts and fixed phases only, never source content. */
export interface GardenerProgress {
  phase: "starting" | "reviewing" | "reading" | "context" | "saving" | "checking" | "finishing" | "retrying";
  waitingForModel: boolean;
  batch: number;
  claims: number;
  rejected: number;
  batches: number;
  lookups: number;
  startedAt: string;
  updatedAt: string;
  firstFilingMs: number | null;
}
