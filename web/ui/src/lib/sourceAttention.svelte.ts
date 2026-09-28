import { vaultFetch as fetch } from "./vaultScope";
import { deliverAction } from "./actionDelivery";
import type { SourceReadStateRow } from "../../../../lib/sourceReadState";
import type { GraphData } from "./types";
import { graphIdentityIndex } from "../../../../lib/graphIdentity";
import { app, showGraphSelection } from "./store.svelte";

export const sourceAttention = $state({ rows: [] as SourceReadStateRow[], loading: false, checked: false, refreshError: "", saving: false, error: "", receipt: "", feedbackSelection: "", selection: "" });
let pending: Promise<void> | undefined;
export function refreshSourceAttention(force = false): Promise<void> {
  return pending ??= (async () => {
    sourceAttention.loading = true;
    try {
      const response = await fetch(`/api/source/read-state${force ? "?refresh=1" : ""}`);
      if (!response.ok) throw new Error("Could not refresh source read state.");
      sourceAttention.rows = (await response.json()).sources;
      sourceAttention.refreshError = "";
    } catch (e) { sourceAttention.refreshError = (e as Error).message; }
    finally { sourceAttention.checked = true; sourceAttention.loading = false; pending = undefined; }
  })();
}
export function unreadNodeIds(graph: GraphData | null): string[] {
  if (!graph) return [];
  const index = graphIdentityIndex(graph.nodes);
  return [...new Set(sourceAttention.rows.filter(r => r.readState.unread === true).flatMap(r => {
    const node = graph.nodes[index.get(r.path) ?? -1];
    return node ? [node.id] : [];
  }))];
}
export function selectUnreadSources(graph: GraphData | null): void {
  const selected = unreadNodeIds(graph);
  if (!selected.length || !graph) return;
  app.graphView = { selected, excluded: [] };
  sourceAttention.selection = JSON.stringify([...selected].sort());
  showGraphSelection(graph.nodes.find(n => n.id === selected[0])?.path ?? null);
}
export function isUnreadSelection(): boolean {
  return !!sourceAttention.selection && !app.graphView.excluded.length && sourceAttention.selection === JSON.stringify([...app.graphView.selected].sort());
}
/** Resolve to individual stored messages so batches never duplicate thread members. */
export function selectedReadSources(graph: GraphData | null, selection = app.graphView.selected): SourceReadStateRow[] {
  if (!selection.length) return [];
  const index = graphIdentityIndex(graph?.nodes ?? []);
  const ids = new Set(selection.map(id => graph?.nodes[index.get(id) ?? -1]?.id).filter((id): id is string => !!id));
  return sourceAttention.rows.filter(r => r.path.startsWith("log/insertions/") && r.readState.writable && (selection.includes(r.path) || ids.has(graph?.nodes[index.get(r.path) ?? -1]?.id ?? "")));
}
export async function markSelectedSources(graph: GraphData | null, unread: boolean, selection = app.graphView.selected): Promise<void> {
  if (sourceAttention.saving) return;
  const paths = selectedReadSources(graph, selection).map(r => r.path);
  if (!paths.length) return;
  sourceAttention.feedbackSelection = JSON.stringify([...selection].sort());
  sourceAttention.saving = true; sourceAttention.error = ""; sourceAttention.receipt = "";
  let confirmed = 0, attempted = 0;
  try {
    await pending; // Finish any pre-write observation before applying receipts.
    for (let offset = 0; offset < paths.length; offset += 100) {
      const batch = paths.slice(offset, offset + 100);
      const response = await deliverAction(actionId => fetch("/api/source/read-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: batch, unread, actionId }) }));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Read-state change could not be confirmed.");
      attempted += batch.length;
      confirmed += body.results.filter((r: { ok: boolean }) => r.ok).length;
      const results = new Map<string, SourceReadStateRow>(body.results.map((r: SourceReadStateRow) => [r.path, r]));
      sourceAttention.rows = sourceAttention.rows.map(r => results.get(r.path) ?? r);
    }
    if (confirmed !== paths.length) sourceAttention.error = `${paths.length - confirmed} messages could not be confirmed. Refresh before retrying.`;
  } catch (e) { sourceAttention.error = `${(e as Error).message} ${paths.length - attempted} messages remain unconfirmed.`; }
  finally {
    sourceAttention.receipt = `${confirmed} of ${paths.length} messages marked ${unread ? "unread" : "read"}.`;
    sourceAttention.saving = false;
    await refreshSourceAttention();
  }
}
