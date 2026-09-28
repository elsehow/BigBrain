import type { actionReceiptView } from "../../../../lib/applicationActions";
export type PublicAction = Partial<ReturnType<typeof actionReceiptView>> & { id: string; operation: string; status: string };
export function actionLabel(operation: string): string {
  return ({ launch_agent: "Start an agent", message_agent: "Send an agent a follow-up", reply_agent: "Answer an agent",
    drop: "Save a contribution", directive: "Save a directive", source_set_unread: "Change source read state",
    "source_set_unread.item": "Change one source's read state", inbox_set_unread: "Change inbox read state", historical: "Earlier action" } as Record<string, string>)[operation] ?? "Application action";
}
export function actionOutcome(action: PublicAction): { label: string; explanation: string } {
  if (action.status === "completed") {
    const observations = action.observations ?? [], missing = observations.filter(o => !o.confirmed).length;
    if (action.operation === "source_set_unread" && !observations.length) return { label: "Outcome unknown", explanation: "No readable item confirmations were saved. Refresh provider state before deciding what to do next." };
    if (missing) return { label: missing < observations.length ? "Partially confirmed" : "Not confirmed", explanation: `${observations.length - missing} of ${observations.length} changes were confirmed. Inspect each item and refresh provider state before deciding what to do next.` };
    return { label: "Confirmed", explanation: "The operation returned a saved result. This does not establish that later work or curation has finished." };
  }
  if (action.status === "failed") return { label: "Not dispatched", explanation: "Authorization or validation stopped this action before dispatch. Review current access and the request before deliberately starting new work." };
  if (action.status === "prepared") return { label: "Not started", explanation: "The request was saved, but dispatch has not been recorded." };
  if (action.status === "executing") return { label: "In progress", explanation: "The operation is running. Refresh to check for a confirmed outcome." };
  return { label: "Outcome unknown", explanation: "The operation may have happened. Inspect existing results before requesting new work; refreshing this history will not repeat it." };
}
export function actionNextStep(operation: string): string {
  if (operation.includes("agent")) return "Inspect the agent conversation and its working folder before sending another request.";
  if (["drop", "directive"].includes(operation)) return "Inspect the saved contribution and recent vault sources. A saved contribution does not establish that curation finished.";
  if (operation.includes("unread")) return "Refresh source or inbox read state to inspect the provider's current state. Earlier observations may have changed.";
  return "Inspect the related conversation and existing results before starting new work.";
}
