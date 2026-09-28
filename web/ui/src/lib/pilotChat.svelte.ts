import { pilotChatDetail, type PilotChatDetail } from "../../../../lib/pilotChatSummary";
import { vaultStorageKey, initializeVault } from "./vaultScope";
import { vaultFetch as fetch } from "./vaultScope";
import { applicationCursor, applicationResponseCurrent } from "./applicationUpdates";
import { mergePilotSummary, fullPilotView, acceptsPilotView, type PilotChatView, isEmptyPublicPilotDraft } from "./pilotChatSync";
import type { PilotChatSummary } from "../../../../lib/pilotChatSummary";
import { usageAction } from "./telemetry";
import { singleFlight } from "./singleFlight";
import type { ChatImage } from "../../../../lib/chatImageTypes";
import { draftImages, setDraftImages, restoreDraftImages, imageUploads } from "./chatImages.svelte";
import { newPilotChatSession } from "../../../../lib/pilotChatTypes";
import { PILOT_LIFECYCLE } from "../../../../lib/pilotLifecycleConfig";
import { pilotCoordination } from "./pilotCoordination";
import { pilotDrafts, restorePilotDraft, keepPilotDraft } from "./pilotDrafts.svelte";
import type { GraphData } from "./types";
import { parseMentions } from "../../../../lib/pilotMentions";
import { findNode } from "../../../../lib/graphIdentity";

export const chat = $state({ loaded: false, connectionError: "", historyError: "", sessions: [] as PilotChatView[], activeId: null as string | null, open: false,
  replyNotification: null as import("../../../../lib/pilotNotifications").PilotNotification | null, messageTarget: null as string | null, messageJump: 0,
  creating: false, interrupting: {} as Record<string, boolean>, error: "", toast: "", focus: 0, queued: {} as Record<string, PilotChatDetail["messages"][number] | undefined>, drafts: pilotDrafts, graph: null as GraphData | null });
const contextAdds = $state<Record<string, string[]>>({});
const mentionNodes = $state<Record<string, NonNullable<PilotChatDetail["contextNodes"]>>>({});
const contextWrites = new Map<string, Promise<void>>();
export const chatSessions = (): PilotChatView[] => {
  // Polling advances the visibility window even when session revisions are unchanged.
  return chat.sessions.map(s => {
  const context = [...new Set([...s.context, ...(contextAdds[s.id] ?? [])])];
  const contextNodes = [...(s.contextNodes ?? []), ...(mentionNodes[s.id] ?? []).filter(n => contextAdds[s.id]?.includes(n.id))];
  return chat.queued[s.id] ? { ...s, context, contextNodes, phase: "working", activity: "connecting", lastActivityAt: chat.queued[s.id]!.at, messages: [...(s.messages ?? []), chat.queued[s.id]!] } : { ...s, context, contextNodes };
});
};
export const activeChat = (): PilotChatView | undefined => chatSessions().find(s => s.id === chat.activeId);
const discarded = new Set<string>();
const deactivating = new Set<string>();
async function request<T>(path = "", body?: unknown, timeoutMs = 30_000): Promise<T> {
  const epoch = applicationCursor.epoch;
  const r = await fetch(`/api/pilot/chat${path}`, { signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!r.ok) {
    const result = await r.json().catch(() => ({}));
    throw Object.assign(new Error(result.error ?? "Pilot could not reach the engine."), { status: r.status });
  }
  const result = await r.json();
  if (!applicationResponseCurrent(epoch)) throw new Error("The engine restarted. Refreshing application views.");
  return result;
}
/** Retry an uncertain delivery with the same ID, including after a page reload. */
export async function submitPilotInput(id: string, text: string, input: { id: string; mode: "text" | "voice"; target?: string; notificationId?: string; images?: ChatImage[] }): Promise<PilotChatDetail> {
  await initializeVault();
  await persistChat(id);
  await contextWrites.get(id);
  await addChatContext(id, mentionIds(text));
  const body = { id, text, inputId: input.id, mode: input.mode, target: input.target, notificationId: input.notificationId, images: input.images };
  const key = vaultStorageKey(`pilot-pending:${id}`);
  const existing = sessionStorage.getItem(key);
  if (existing && JSON.parse(existing).inputId !== input.id) throw new Error("An earlier message has uncertain delivery. Retry it before sending another.");
  try { sessionStorage.setItem(key, JSON.stringify(body)); } catch { /* storage unavailable */ }
  let error: unknown;
  for (let retry = 0; retry < 3; retry++) {
    try {
      const result = await request<PilotChatDetail>("/send", body);
      accept(result);
      usageAction("pilot_input_accepted", input.id);
      try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ }
      return result;
    } catch (e) { error = e; if (retry < 2) await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  throw error;
}
export async function retryPilotInput(id: string): Promise<void> {
  const saved = sessionStorage.getItem(vaultStorageKey(`pilot-pending:${id}`));
  if (!saved) return;
  const b = JSON.parse(saved);
  await submitPilotInput(id, b.text, { id: b.inputId, mode: b.mode, target: b.target, notificationId: b.notificationId, images: b.images });
}
export async function updateChatBackend(id: string, backend: unknown): Promise<void> {
  accept(await request<PilotChatDetail>("/backend", { id, backend }));
}
export async function resumeChatQueue(id: string): Promise<void> { accept(await request<PilotChatDetail>("/resume", { id })); }
function accept(incoming: PilotChatSummary | PilotChatDetail, detail = true): void {
  let s: PilotChatView = detail && "messages" in incoming ? fullPilotView(incoming) : mergePilotSummary(incoming, chat.sessions.find(s => s.id === incoming.id));
  if (discarded.has(s.id)) return;
  if (deactivating.has(s.id)) s = { ...s, lifecycle: "dormant", phase: s.phase === "working" ? "interrupted" : s.phase };
  else if (chat.interrupting[s.id] && s.phase === "working") s = { ...s, phase: "interrupted" };
  const existing = chat.sessions.find(n => n.id === s.id);
  if (!acceptsPilotView(existing, s, detail)) return;
  chat.sessions = [...chat.sessions.filter(n => n.id !== s.id), s];
  if ((s.ingestions?.length ?? 0) !== (existing?.ingestions?.length ?? 0)) pilotCoordination().recordChanged();
  if (existing?.phase === "working" && s.phase !== "working") pilotCoordination().settled();
  if (existing?.phase === "working" && s.phase !== "working" && chat.activeId === s.id && chat.open) chat.focus++;
  restorePilotDraft(s.id, s.draft);
  restoreDraftImages(s.id, s.draftImages);
}
async function fetchChats(ids?: string[]): Promise<void> {
  try {
  const known = new Map(chat.sessions.filter(s => !unpersisted.has(s.id) && !creations.has(s.id) && !sending.has(s.id)).map(s => [s.id, s.revision]));
  const { sessions, issues } = await request<{ sessions: (PilotChatSummary | PilotChatDetail)[]; issues?: { file: string; message: string }[] }>(ids ? `?ids=${encodeURIComponent(ids.join(","))}` : "");
  chat.historyError = issues?.map(issue => `${issue.message} (${issue.file.split("/").at(-1)})`).join("\n") ?? "";
  if (!Array.isArray(sessions)) throw new Error("The server does not support Pilot sessions.");
  const present = new Set(sessions.map(s => s.id));
  // Reconcile backend removals, while preserving optimistic creations and
  // unsaved text. A list started before a new session must not erase it.
  const retained = chat.sessions.filter(s => ids && !ids.includes(s.id) || present.has(s.id) || known.get(s.id) !== s.revision || unpersisted.has(s.id)
    || creations.has(s.id) || sending.has(s.id) || !!chat.drafts[s.id]?.trim());
  if (retained.length !== chat.sessions.length) chat.sessions = retained;
  for (const s of sessions) {
    // Component fixtures may supply full records; the application supplies summaries.
    if ("messages" in s) accept(s);
    else accept(s, false);
  }
  await Promise.all(chat.sessions.filter(s => s.id === chat.activeId || s.phase === "working" || s.detailRevision !== undefined)
    .map(s => loadChatDetail(s.id)));
  chat.loaded = true;
  chat.connectionError = "";
  } catch (e) {
    chat.connectionError = "Pilot sessions are unavailable. Check the backend connection and retry.";
    throw e;
  }
}
export const refreshChats = singleFlight(() => fetchChats());
export const refreshChatIds = (ids: string[]) => fetchChats(ids);
const detailLoads = new Map<string, Promise<void>>();
export async function loadChatDetail(id: string): Promise<void> {
  const s = chat.sessions.find(s => s.id === id);
  if (!s || unpersisted.has(id) || s.detailRevision === s.revision) return;
  if (detailLoads.has(id)) return detailLoads.get(id);
  s.detail = { status: "loading" };
  const task = request<PilotChatDetail>(`/session?id=${encodeURIComponent(id)}`).then(s => accept(s))
    .catch(e => { const current = chat.sessions.find(s => s.id === id); if (current) current.detail = { status: "error", error: e.message }; throw e; })
    .finally(() => {
      detailLoads.delete(id);
      const current = chat.sessions.find(s => s.id === id);
      if (current?.detail.status === "loading") current.detail = { status: current.messages ? "loaded" : "unloaded" };
    });
  detailLoads.set(id, task); return task;
}
/** Reopen the existing conversation and its owned context without a new session. */
export function openChat(id: string, options: { replace?: boolean; focus?: boolean } = {}): void {
  if (!chat.sessions.some(s => s.id === id)) return;
  if (chat.activeId && chat.activeId !== id) void leaveChat();
  void loadChatDetail(id).catch(() => {}); // The panel owns this session's loading/error state.
  chat.activeId = id; chat.open = true; chat.focus++;
  pilotCoordination().navigate(id, options.replace, options.focus);
}
export async function startChat(selection?: string[]): Promise<void> {
  if (activeChat()) { if (!selection) return; await leaveChat(); }
  chat.error = "";
  const context = (selection ?? pilotCoordination().selection()).filter(id => !chat.sessions.some(s => s.id === id));
  const s = pilotChatDetail(newPilotChatSession(context)); accept(s); unpersisted.add(s.id);
  chat.activeId = s.id; chat.open = true; chat.focus++;
  pilotCoordination().navigate(s.id);
  // The first paint and keyboard focus never wait for graph validation or I/O.
  try { await persistChat(s.id); } catch (e) { chat.error = (e as Error).message; }
}
const unpersisted = new Set<string>();
const creations = new Map<string, Promise<void>>();
async function persistChat(id: string): Promise<void> {
  if (!unpersisted.has(id)) return;
  if (creations.has(id)) return creations.get(id);
  const s = chat.sessions.find(s => s.id === id); if (!s) throw new Error("Pilot draft is unavailable.");
  const task = request<PilotChatDetail>("/create", { id, context: s.seed }).then(result => { accept(result); unpersisted.delete(id); }).finally(() => creations.delete(id));
  creations.set(id, task); return task;
}
/** Component lifetime owns a tab-specific lease. Browser close is best effort;
 * lease expiry handles crashes, sleeping tabs and disconnected clients. */
export function holdChatComposer(id: string): () => void {
  const client = crypto.randomUUID(); let disposed = false;
  let pending = Promise.resolve();
  const pulse = () => {
    pending = pending.catch(() => {}).then(async () => {
      await persistChat(id);
      if (!disposed) await request("/presence", { client, id });
    });
    void pending.catch(() => {});
  };
  const release = () => {
    disposed = true;
    void pending.catch(() => {}).then(() => fetch("/api/pilot/chat/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client, id: null }), keepalive: true })).catch(() => {});
  };
  pulse(); const timer = setInterval(pulse, PILOT_LIFECYCLE.composerHeartbeatMs);
  const hide = () => { disposed = true; navigator.sendBeacon("/api/pilot/chat/presence", new Blob([JSON.stringify({ client, id: null })], { type: "application/json" })); };
  window.addEventListener("pagehide", hide);
  return () => { clearInterval(timer); window.removeEventListener("pagehide", hide); release(); };
}
const pendingDrafts = new Map<string, ReturnType<typeof setTimeout>>();
const draftWrites = new Map<string, Promise<void>>();
const sending = new Map<string, { cancelled: boolean; dispatched: boolean; accepted: boolean; text: string; done?: Promise<void> }>();
export function editChatDraft(id: string, text: string): void {
  const previous = new Set(mentionIds(chat.drafts[id] ?? chat.sessions.find(s => s.id === id)?.draft ?? ""));
  const added = mentionIds(text).filter(ref => !previous.has(ref));
  keepPilotDraft(id, text);
  if (added.length) void addChatContext(id, added).catch(() => {});
  clearTimeout(pendingDrafts.get(id));
  pendingDrafts.set(id, setTimeout(() => { void saveChatDraft(id).catch(() => {}); }, 350));
}
const mentionIds = (text: string): string[] => parseMentions(text).flatMap(p => "mention" in p ? [p.mention.id] : []);
async function persistContextAdd(id: string, refs: string[]): Promise<PilotChatDetail> {
  try { return await request<PilotChatDetail>("/context-add", { id, nodes: refs }); }
  catch (e) { if ((e as { status?: number }).status !== 404) throw e; }
  // A hot-reloaded UI can outlive its backend version while an agent is running.
  // Older engines support revision-checked replacement; always merge a fresh read.
  for (let attempt = 0; ; attempt++) {
    const { sessions } = await request<{ sessions: (PilotChatSummary | PilotChatDetail)[] }>();
    const s = sessions.find(s => s.id === id);
    if (!s) throw new Error("Pilot session is unavailable.");
    try { return await request<PilotChatDetail>("/context", { id, nodes: [...new Set([...s.context, ...refs])], title: s.title, expectedRevision: s.viewRevision }); }
    catch (e) { if ((e as { status?: number }).status !== 409 || attempt >= 2) throw e; }
  }
}
export function addChatContext(id: string, refs: string[]): Promise<void> {
  const s = chat.sessions.find(s => s.id === id);
  if (!s || !refs.length) return Promise.resolve();
  const graph = chat.graph?.nodes ?? [];
  const ids = [...new Set(refs.map(ref => graph[findNode(graph, ref)]?.id ?? ref))].filter(ref => ref !== id && !s.context.includes(ref));
  if (!ids.length) return contextWrites.get(id) ?? Promise.resolve();
  contextAdds[id] = [...new Set([...(contextAdds[id] ?? []), ...ids])];
  mentionNodes[id] = [...(mentionNodes[id] ?? []), ...parseMentions(chat.drafts[id] ?? s.draft).flatMap(p =>
    "mention" in p && ids.includes(p.mention.id) && !p.mention.id.startsWith("pilot-")
      ? [{ id: p.mention.id, path: p.mention.id, title: p.mention.title, group: p.mention.tag === "MEMORY" ? "memory" : p.mention.tag === "ENTITY" ? "entity" : "source" }] : [])];
  const task = (contextWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await persistChat(id);
    accept(await persistContextAdd(id, refs));
  }).catch(e => { chat.error = `Could not attach mentioned context: ${e.message}`; throw e; }).finally(() => {
    contextAdds[id] = (contextAdds[id] ?? []).filter(ref => !ids.includes(ref));
    mentionNodes[id] = (mentionNodes[id] ?? []).filter(n => contextAdds[id]?.includes(n.id));
    if (contextWrites.get(id) === task) contextWrites.delete(id);
  });
  contextWrites.set(id, task);
  return task;
}
export async function saveChatDraft(id: string, text = chat.drafts[id] ?? ""): Promise<void> {
  clearTimeout(pendingDrafts.get(id)); pendingDrafts.delete(id);
  const images = draftImages(id);
  const task = (draftWrites.get(id) ?? Promise.resolve()).then(async () => {
    await persistChat(id);
    accept(await request<PilotChatDetail>("/draft", { id, text, images }));
  });
  draftWrites.set(id, task.catch(() => {}));
  try { await task; } catch (e) { chat.error = (e as Error).message; throw e; }
}
export async function leaveChat(): Promise<void> {
  const s = activeChat();
  chat.activeId = null; chat.open = false;
  if (!s) return;
  const text = chat.drafts[s.id] ?? s.draft;
  const saved = saveChatDraft(s.id);
  const empty = !draftImages(s.id).length && isEmptyPublicPilotDraft({ ...s, draft: text });
  if (empty) { discarded.add(s.id); chat.sessions = chat.sessions.filter(n => n.id !== s.id); }
  try {
    await saved;
    if (empty) {
      await request("/discard", { id: s.id }, 8000); delete chat.drafts[s.id];
    }
  } catch { chat.toast = empty ? "Pilot closed here, but the backend could not discard it. It may still need cleanup." : "The draft is kept here, but could not be saved to the backend."; }
}
export async function sendChat(): Promise<void> {
  const s = activeChat(), text = s ? chat.drafts[s.id] ?? s.draft : "";
  const images = s ? draftImages(s.id) : [];
  if (!s || chat.interrupting[s.id] || sending.has(s.id) || imageUploads[s.id]?.busy || (!text.trim() && !images.length)) return;
  const attempt = { id: crypto.randomUUID(), cancelled: false, dispatched: false, accepted: false, text, done: undefined as Promise<void> | undefined }; sending.set(s.id, attempt);
  chat.error = "";
  chat.queued[s.id] = { id: crypto.randomUUID(), role: "user", text, images, at: new Date().toISOString() };
  keepPilotDraft(s.id, "");
  attempt.done = (async () => {
    try {
      await saveChatDraft(s.id, text);
      if (attempt.cancelled) return;
      attempt.dispatched = true;
      const saved = sessionStorage.getItem(vaultStorageKey(`pilot-pending:${s.id}`));
      const pending = saved ? JSON.parse(saved) : undefined;
      if (pending && (pending.text !== text || JSON.stringify(pending.images ?? []) !== JSON.stringify(images))) throw new Error("An earlier message has uncertain delivery. Retry it before sending a different message.");
      const result = await submitPilotInput(s.id, text, { id: pending?.inputId ?? attempt.id, mode: "text", images, notificationId: pending?.notificationId ?? (chat.replyNotification?.pilotId === s.id ? chat.replyNotification.id : undefined) });
      chat.replyNotification = null;
      attempt.accepted = true;
      setDraftImages(s.id, draftImages(s.id).filter(image => !images.some(sent => sent.id === image.id)));
      accept(result); delete chat.queued[s.id];
      // A follow-up can be typed while the first message is connecting. The
      // send endpoint clears its old draft, so persist the newer text afterward.
      if (chat.drafts[s.id]) await saveChatDraft(s.id);
      if (chat.activeId === s.id && chat.open) chat.focus++;
    } catch (e) {
      chat.error = (e as Error).message;
      if (!attempt.accepted && (!attempt.cancelled || attempt.dispatched)) chat.drafts[s.id] = text + (chat.drafts[s.id] ? `\n\n${chat.drafts[s.id]}` : "");
    } finally { delete chat.queued[s.id]; sending.delete(s.id); }
  })();
  await attempt.done;
}
function cancelPendingSend(id: string) {
  const attempt = sending.get(id);
  if (attempt && !attempt.cancelled) {
    attempt.cancelled = true;
    if (!attempt.dispatched) {
      chat.drafts[id] = attempt.text + (chat.drafts[id] ? `\n\n${chat.drafts[id]}` : "");
      delete chat.queued[id];
    }
  }
  return attempt;
}
/** Archiving is backend-owned. Keep the tab and any failure visible until
 * Pilot and its agent sessions have stopped. */
export async function archiveChat(id = chat.activeId, confirmed = false): Promise<boolean> {
  const s = chat.sessions.find(s => s.id === id); if (!s || chat.interrupting[s.id]) return false;
  const attempt = cancelPendingSend(s.id);
  delete chat.queued[s.id];
  chat.interrupting[s.id] = true; chat.error = "";
  try {
    await attempt?.done;
    await saveChatDraft(s.id, chat.drafts[s.id] ?? s.draft);
    const result = await request<PilotChatDetail>("/stop-tree", { id: s.id, confirmed });
    await pilotCoordination().refreshWorkers();
    delete chat.interrupting[s.id]; accept(result);
    if (chat.activeId === s.id) { chat.activeId = null; chat.open = false; pilotCoordination().clearSelection(); }
    return true;
  } catch (e) {
    chat.error = (e as { status?: number }).status === 404 ? "Archiving agent sessions requires the updated backend. Restart it when existing work can safely be interrupted." : (e as Error).message;
    return false;
  } finally { delete chat.interrupting[s.id]; void refreshChats().catch(() => {}); }
}
export async function stopChat(id = chat.activeId): Promise<void> {
  if (!id || chat.interrupting[id]) return;
  const attempt = cancelPendingSend(id);
  chat.interrupting[id] = true;
  chat.sessions = chat.sessions.map(s => s.id === id ? { ...s, phase: "interrupted" } : s);
  try {
    await attempt?.done;
    if (attempt && !attempt.dispatched) return;
    await persistChat(id);
    accept(await request<PilotChatDetail>("/stop", { id }, 8000));
  } catch {
    chat.toast = "Pilot could not be interrupted. It may still be working.";
    if (!deactivating.has(id)) chat.sessions = chat.sessions.map(s => s.id === id && (!s.lifecycle || s.lifecycle === "active") && s.phase === "interrupted" ? { ...s, phase: "working" } : s);
  }
  finally { delete chat.interrupting[id]; void refreshChats().catch(() => {}); }
}
export async function renameChat(id: string, title: string): Promise<void> {
  await contextWrites.get(id);
  const latest = chat.sessions.find(s => s.id === id);
  if (!latest) return;
  accept(await request<PilotChatDetail>("/context", { id, nodes: latest.context, title, expectedRevision: latest.viewRevision }));
}

export async function removeChatContext(id: string): Promise<void> {
  const s = activeChat(); if (!s) return;
  try {
    await contextWrites.get(s.id);
    const latest = activeChat(); if (!latest || latest.id !== s.id) return;
    accept(await request<PilotChatDetail>("/context", { id: s.id, nodes: latest.context.filter(n => n !== id), title: latest.title, expectedRevision: latest.viewRevision }));
  }
  catch (e) { chat.error = (e as Error).message; await refreshChats().catch(() => {}); }
}
