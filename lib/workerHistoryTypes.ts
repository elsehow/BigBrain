/** Read-only record shapes from the retired worker runtime. */
/** Historical grants are descriptive only and cannot authorize execution. */
export interface ProjectGrant { path: string; mode: "read" | "work"; references: string[]; domains: string[]; accounts: { integration: "email" | "granola"; account: string }[]; network?: "public"; credentials?: string[] }
export type WorkerRequest = { id: string; kind: "context" | "question"; text: string } | { id: string; kind: "access"; text: string; grant: ProjectGrant; label?: string; initial?: boolean };
/** A follow-up instruction: queued (durably accepted) -> delivered (observed in the
 * worker's model context) or withdrawn (stop, failure, restart; never resent). */
export interface WorkerSteering { id: string; text: string; at: string; status: "queued" | "delivered" | "withdrawn"; delivery: "started" | "steer"; deliveredAt?: string; withdrawnAt?: string; reason?: string }
export interface HistoricalWorker {
  projectId?: string; grant?: ProjectGrant; request?: WorkerRequest; archivedAt?: string;
  isolation?: "scratch" | "checkout" | "direct" | "read"; steering?: WorkerSteering[];
  operations: { id: string; tool: string; status: "started" | "completed" | "failed" | "uncertain"; at: string }[];
}
