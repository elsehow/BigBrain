import { vaultFetch as fetch } from "./vaultScope";
import { applicationDisconnected, epochRequest } from "./applicationUpdates";
import { singleFlight } from "./singleFlight";
import { delegatingPilots } from "./pilotAttention";
import type { WorkContextView, WorkSummary } from "../../../../lib/workViews";
import { sessionPath } from "../../../../lib/workSessionView";
import type { GraphData } from "./types";
import { app, gotoNote } from "./store.svelte";

let savedCwd = "";
try { savedCwd = localStorage.getItem("bigbrain.work.cwd") ?? ""; } catch { /* storage unavailable */ }
export const work = $state({ loaded: false, selectedTitle: "", sessions: [] as WorkSummary[], graph: null as GraphData | null, error: "", context: {} as WorkContextView, cwd: savedCwd });
export function workRequest<T>(path = "", body?: Record<string, unknown>): Promise<T> {
  return epochRequest(async () => {
    const response = await fetch(`/api/pilot/work${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Session request failed");
    return result;
  }, !body);
}
async function fetchWork(ids?: string[]): Promise<void> {
  try {
    const known = new Map(work.sessions.map(s => [s.id, s.revision ?? s.updated]));
    const result = await workRequest<{ sessions: WorkSummary[] }>(ids ? `?ids=${encodeURIComponent(ids.join(","))}` : "");
    result.sessions = result.sessions.filter(s => !s.migratedToPilot);
    const next = [...work.sessions.filter(s => (ids && !ids.includes(s.id)) || (!result.sessions.some(n => n.id === s.id) && known.get(s.id) !== (s.revision ?? s.updated))), ...result.sessions.map(s => {
      const old = work.sessions.find(o => o.id === s.id);
      return old && (old.revision !== undefined && s.revision !== undefined ? old.revision >= s.revision : old.updated === s.updated) ? old : s;
    })].sort((a, b) => b.updated.localeCompare(a.updated));
    if (next.length !== work.sessions.length || next.some((s, i) => s !== work.sessions[i])) work.sessions = next;
    work.loaded = true;
    work.error = "";
  } catch (e) {
    // Disconnection is not evidence a worker is still live.
    // Keep durable history. A network failure does not prove a worker stopped.
    work.error = e instanceof Error ? e.message : "Could not refresh sessions";
    applicationDisconnected();
  }
}
export const refreshWork = singleFlight(() => fetchWork());
// Pilots whose workers are running, keyed as a string so views only update when the set changes.
const delegatingKey = $derived([...delegatingPilots(work.sessions)].sort().join("\n"));
export function delegatingPilotIds(): ReadonlySet<string> { return new Set(delegatingKey ? delegatingKey.split("\n") : []); }
export const refreshWorkIds = (ids: string[]) => fetchWork(ids);
export function selectWork(id: string): void {
  gotoNote(work.graph?.nodes.find(n => n.sourcePaths?.includes(sessionPath(id)))?.path ?? sessionPath(id));
}
export function captureWorkContextView(): WorkContextView {
  const node = work.graph?.nodes.find(n => (n.path === app.activeNote || !!n.sourcePaths?.includes(app.activeNote ?? "")) || n.id === app.activeNote);
  const selected = work.sessions.find(s => node?.sourcePaths?.includes(sessionPath(s.id)) || sessionPath(s.id) === app.activeNote);
  return {
    ...(selected ? selected.context : {}),
    node: app.activeNote || selected?.context.node || undefined,
    title: selected?.title || work.selectedTitle || undefined,
    text: window.getSelection()?.toString().slice(0, 12_000) || undefined,
    session: selected?.id,
    requestKey: selected?.pending ? selected.attention?.key : undefined,
    cwd: selected?.cwd || work.cwd || undefined,
  };
}
