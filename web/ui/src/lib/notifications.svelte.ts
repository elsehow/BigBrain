import { vaultFetch as fetch } from "./vaultScope";
import type { PilotNotification } from "../../../../lib/pilotNotifications";
import type { NotificationItem } from "./notificationTypes";
import { chat, openChat, loadChatDetail, refreshChats } from "./pilotChat.svelte";
import { searchOverlay } from "./omnibox.svelte";

export const notifications = $state({ items: [] as PilotNotification[], toastIds: [] as string[], error: "" });
let knownIds: Set<string> | undefined;
export async function refreshNotifications(): Promise<void> {
  const next = chat.sessions.flatMap(s => s.notifications ?? []).sort((a, b) => b.at.localeCompare(a.at));
  if (knownIds) notifications.toastIds = [...notifications.toastIds, ...next.filter(n => !knownIds!.has(n.id) && !n.seen && !n.dismissed && !n.resolved).map(n => n.id)];
  knownIds = new Set(next.map(n => n.id));
  notifications.items = next;
}

export async function changeNotification(id: string, action: "seen" | "unseen" | "dismiss"): Promise<void> {
  if (!notifications.items.some(n => n.id === id)) return;
  const response = await fetch("/api/pilot/chat/notification-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action }) });
  if (!response.ok) throw new Error("Notification change could not be saved. Try again.");
  const patch = action === 'seen' ? { seen: true } : action === 'unseen' ? { seen: false, dismissed: false } : { dismissed: true };
  notifications.items = notifications.items.map(n => n.id === id ? { ...n, ...patch } : n);
  chat.sessions = chat.sessions.map(s => ({ ...s, notifications: s.notifications?.map(n => n.id === id ? { ...n, ...patch } : n) }));
}
export function updateNotification(id: string, action: "seen" | "unseen" | "dismiss"): void {
  void changeNotification(id, action).catch(e => notifications.error = e.message);
}
export async function openNotification(id: string): Promise<void> {
  const notice = notifications.items.find(n => n.id === id);
  if (!notice) return;
  updateNotification(id, "seen");
  notifications.toastIds = notifications.toastIds.filter(value => value !== id);
  searchOverlay.open = false;
  try {
    if (!chat.sessions.some(s => s.id === notice.pilotId)) await refreshChats();
    await loadChatDetail(notice.pilotId);
    if (!chat.sessions.some(s => s.id === notice.pilotId)) throw new Error("This Pilot is unavailable. Try refreshing.");
    openChat(notice.pilotId);
    chat.messageTarget = notice.messageId;
    chat.messageJump++;
    chat.replyNotification = notice.kind === "question" && !notice.resolved ? notice : null;
  } catch (e) { notifications.error = (e as Error).message; }
}

/** Recent arrivals remain in the corner stack until opened or dismissed. */
export function stackedNotifications(): NotificationItem[] {
  return notifications.toastIds.flatMap(id => {
    const item = notifications.items.find(item => item.id === id);
    return item && !item.dismissed && !item.resolved && !item.seen ? [item] : [];
  });
}
