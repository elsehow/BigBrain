import type { PilotChatDetail, PilotChatSummary } from "../../../../lib/pilotChatSummary";
export type { PilotChatDetail, PilotChatSummary } from "../../../../lib/pilotChatSummary";
/** Display helpers consume only public fields, whether summary or loaded detail. */
export type PilotViewData = PilotChatSummary &
  Partial<Pick<PilotChatDetail, "messages" | "inputs" | "spoken">>;
export type DetailState = { status: "unloaded" } | { status: "loading" } | { status: "error"; error: string } | { status: "loaded" };
/** Summary updates never fabricate an empty transcript or erase loaded detail. */
export type PilotChatView = PilotViewData & { detail: DetailState; detailRevision?: number };
export function mergePilotSummary(summary: PilotChatSummary, current?: PilotChatView): PilotChatView {
  return { ...summary, messages: current?.messages, inputs: current?.inputs, spoken: current?.spoken,
    detail: current?.detail ?? { status: "unloaded" }, detailRevision: current?.detailRevision };
}
export function fullPilotView(session: PilotChatDetail): PilotChatView {
  return { ...session, messageCount: session.messages.length, detail: { status: "loaded" }, detailRevision: session.revision };
}
/** One ordering rule for HTTP details, summaries and deterministic replays. */
export function acceptsPilotView(current: PilotChatView | undefined, incoming: Pick<PilotChatSummary, "revision">, detail: boolean): boolean {
  return !current || !(current.revision > incoming.revision || current.revision === incoming.revision && (!detail || current.detailRevision === incoming.revision));
}

export const isEmptyPublicPilotDraft = (s: PilotViewData): boolean => s.phase === "draft" && !s.deactivatedAt && !s.draft.trim() && !s.draftImages?.length && !(s.messageCount ?? s.messages?.length) && !s.hasHistory && !s.live && !s.ingestions?.length;
