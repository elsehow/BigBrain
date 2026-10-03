import { lastMessageAt } from "./messageTime";
import type { PilotChatSession } from "./pilotChatTypes";
import { desktopDetail } from "./pilotDesktop";

import { fields, imageView, notificationView, outputView } from "./publicViews";
const summaryFields = ["id", "title", "titleSource", "model", "transport", "phase", "lifecycle", "lastActivityAt", "deactivatedAt", "ingestedMessages", "ingestionError", "seed", "context", "viewRevision", "revision", "draft", "live", "activity", "error", "created", "updated"] as const;
const inputView = (v: NonNullable<PilotChatSession["pendingInputs"]>[number]) => ({ ...fields(v, ["id", "text", "mode", "target", "notificationId"]), images: v.images?.map(imageView) });
/** Navigation/status and graph activity, independent of the storage schema. */
export type PilotChatSummary = ReturnType<typeof pilotChatSummary>;
export function pilotChatSummary(s: PilotChatSession) {
  const answered = new Set([...(s.inputs ?? []), ...(s.pendingInputs ?? [])].map(i => i.notificationId));
  return { ...fields(s, summaryFields),
    backend: s.backend && fields(s.backend, ["adapter", "provider", "model", "reasoning"]),
    category: s.category && fields(s.category, ["memory", "inputKey", "model", "assignedAt", "reason"]),
    contextNodes: s.contextNodes?.map(n => fields(n, ["id", "path", "title", "group"])),
    legacyWork: s.legacyWork && { ...fields(s.legacyWork, ["id", "provider", "thread", "cwd"]), outputs: s.legacyWork.outputs.map(outputView) },
    ingestions: s.ingestions?.map(i => fields(i, ["through", "sourceId", "insertionId", "path"])),
    draftImages: s.draftImages?.map(imageView), pendingInputs: s.pendingInputs?.map(inputView),
    lastMessageAt: lastMessageAt(s), notifications: s.notifications?.map(n => ({ ...notificationView(n), pilotTitle: s.title, resolved: n.resolved || answered.has(n.id) })),
    messageCount: s.messages.length, hasHistory: !!(s.messages.length || s.inputs?.length || s.workEvents?.length || s.pendingIngestion) };
}
export type PilotChatDetail = ReturnType<typeof pilotChatDetail>;
export function pilotChatDetail(s: PilotChatSession) {
  return { ...pilotChatSummary(s),
    messages: s.messages.map(m => ({ ...fields(m, ["id", "role", "text", "at", "replyTo"]), images: m.images?.map(imageView) })),
    inputs: s.inputs?.map(i => ({ ...inputView(i), message: i.message })),
    spoken: s.spoken?.map(i => fields(i, ["id", "message", "text", "status", "at"])),
    ...(s.desktop ? { desktop: desktopDetail(s.desktop) } : {}),
  };
}
export const pilotMessageCount = (s: { messages?: unknown[]; messageCount?: number }): number => s.messageCount ?? s.messages?.length ?? 0;
export function matchesPilotQuery(s: { title: string; draft: string; messages: readonly { text: string }[] }, query: string): boolean {
  const words = query.trim().toLocaleLowerCase();
  if (!words) return true;
  const text = `${s.title}\n${s.draft}\n${s.messages.map(m => m.text).join("\n")}`.toLocaleLowerCase();
  return words.split(/\s+/).every(word => text.includes(word));
}
