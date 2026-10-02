import type { PilotChatDetail } from "../../../../lib/pilotChatSummary";
/** Envelope IDs are not input IDs. Only durable receipts acknowledge delivery. */
export function pilotInputReceipt(s: Partial<Pick<PilotChatDetail, "inputs" | "pendingInputs">>, id: string) {
  const accepted = s.inputs?.find(input => input.id === id);
  if (accepted) return { kind: "accepted" as const, message: accepted.message, images: accepted.images };
  const queued = s.pendingInputs?.find(input => input.id === id);
  return queued ? { kind: "queued" as const, images: queued.images } : undefined;
}
