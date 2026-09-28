import type { WorkSession } from "./workHistory";
import { fields, imageView, outputView, grantView } from "./publicViews";
import { lastMessageAt } from "./messageTime";
import { workAttention } from "./workAttention";
export type WorkSummary = ReturnType<typeof workSummary>;
export function workSummary(job: WorkSession) {
  const w = job.worker;
  const request = w?.request;
  return { ...fields(job, ["id", "revision", "title", "cwd", "provider", "thread", "status", "model", "created", "updated", "lastActivityAt", "migratedToPilot", "error", "cancelRequested"]),
    choice: job.choice && fields(job.choice, ["adapter", "provider", "model", "reasoning"]),
    context: fields(job.context, ["requestKey", "nodes", "node", "title", "text", "session", "cwd"]),
    origin: job.origin && fields(job.origin, ["pilot", "message"]),
    outputs: job.outputs?.map(outputView),
    external: job.external && { adapter: job.external.adapter, connected: false, archivedAt: job.external.archivedAt, capabilities: { open: "resume" as const, interrupt: false, followUp: false } },
    worker: w && { ...fields(w, ["projectId", "archivedAt", "isolation"]), grant: w.grant && grantView(w.grant),
      request: request && (request.kind === "access" ? { ...fields(request, ["id", "kind", "text", "initial", "label"]), grant: grantView(request.grant) } : fields(request, ["id", "kind", "text"])),
      operations: w.operations.map(o => fields(o, ["id", "tool", "status", "at"])),
      steering: w.steering?.map(s => fields(s, ["id", "text", "at", "status", "delivery", "deliveredAt", "reason"])) },
    lastMessageAt: lastMessageAt(job), pending: !!request, attention: workAttention(job) };
}
export type WorkDetail = ReturnType<typeof workDetail>;
export type WorkContextView = WorkSummary["context"];
export function workDetail(job: WorkSession) {
  return { ...workSummary(job), receipts: [...job.receipts], messages: job.messages.map(m => ({ ...fields(m, ["id", "role", "text", "at"]), images: m.images?.map(imageView) })) };
}
