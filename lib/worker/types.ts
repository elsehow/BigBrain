import type { ModelChoice } from "../modelChoice";
import type { WorkContext, WorkMessage } from "../workHistory";
import type { ProjectGrant } from "./projects";
export type WorkerRequest = { id: string; kind: "context" | "question"; text: string } | { id: string; kind: "access"; text: string; grant: ProjectGrant; label?: string; initial?: boolean };
/** A follow-up instruction: queued (durably accepted) -> delivered (observed in the
 * worker's model context) or withdrawn (stop, failure, restart; never resent). */
export interface WorkerSteering { id: string; text: string; at: string; status: "queued" | "delivered" | "withdrawn"; delivery: "started" | "steer"; deliveredAt?: string; reason?: string }
export interface WorkerRecord {
  reportOutbox?: import("../agentOrchestrator").AgentSessionReport[];
  revision?: number;
  version: 1; id: string; title: string; cwd: string; provider: "pi"; model: string; choice: ModelChoice;
  status: "starting" | "working" | "needs-input" | "idle" | "interrupted" | "failed";
  origin: { pilot: string; message: string }; context: WorkContext;
  created: string; updated: string; lastActivityAt?: string; messages: WorkMessage[]; receipts: string[]; error?: string; cancelRequested?: boolean;
  worker: { projectId?: string; grant?: ProjectGrant; ceiling?: ProjectGrant; request?: WorkerRequest; archivedAt?: string; isolation?: "scratch" | "checkout" | "direct" | "read"; steering?: WorkerSteering[];
    operations: { id: string; tool: string; status: "started" | "completed" | "failed" | "uncertain"; at: string }[] };
}
