import type { WorkSession } from "./workHistory";

export interface SessionQuestion { id: string; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }
export interface WorkAttention {
  key: string; session: string; title: string; kind: "question" | "approval" | "completed" | "failed";
  text: string; context?: string; questions: SessionQuestion[]; detail?: string; announced: boolean;
}
export function workAttention(job: WorkSession): WorkAttention | undefined {
  const request = job.worker?.request;
  if (request && request.kind !== "context") return { key: request.id, session: job.id, title: job.title, kind: request.kind === "access" ? "approval" : "question", text: request.text, questions: [], announced: false };
  // Historical native requests are readable evidence, never actionable approvals.
}
