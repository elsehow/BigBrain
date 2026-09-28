import type { ModelChoice } from "../modelChoice";
import type { WorkContext, WorkMessage } from "../workHistory";
import type { ProjectGrant } from "./projects";
export type WorkerRequest = { id: string; kind: "context" | "question"; text: string } | { id: string; kind: "access"; text: string; grant: ProjectGrant; label?: string; initial?: boolean };
export interface WorkerRecord {
  reportOutbox?: import("../agentOrchestrator").AgentSessionReport[];
  revision?: number;
  version: 1; id: string; title: string; cwd: string; provider: "pi"; model: string; choice: ModelChoice;
  status: "starting" | "working" | "needs-input" | "idle" | "interrupted" | "failed";
  origin: { pilot: string; message: string; action?: string }; context: WorkContext;
  created: string; updated: string; lastActivityAt?: string; messages: WorkMessage[]; receipts: string[]; error?: string; cancelRequested?: boolean;
  worker: { projectId?: string; grant?: ProjectGrant; ceiling?: ProjectGrant; request?: WorkerRequest; archivedAt?: string; isolation?: "scratch" | "checkout" | "direct" | "read";
    operations: { id: string; tool: string; status: "started" | "completed" | "failed" | "uncertain"; at: string }[] };
}
