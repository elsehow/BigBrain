import { vaultStorageKey, vaultReady, assertVaultCurrent } from "./vaultScope";
import { vaultFetch as fetch } from "./vaultScope";
import type { NoteBriefing, NoteBriefingEvent } from "../../../../lib/noteBriefing";
import { normalizeGraphView, type GraphViewState } from "../../../../lib/graphView";

// Navigation must not wait for debounce, a round trip, or evidence hashing.
// Like the note/graph SWR cache, retain the last completed view while the
// server checks freshness. Never cache partial or failed generations.
type BriefingSelection = GraphViewState & { purpose?: "unread" };
const namespace = "bb:note-briefing:14:";
const completed = new Map<string, NoteBriefing>();
const cacheKey = (selection: BriefingSelection) => vaultStorageKey(namespace) + JSON.stringify({ ...normalizeGraphView(selection), purpose: selection.purpose });
function remember(key: string, briefing: NoteBriefing): NoteBriefing {
  completed.delete(key);
  completed.set(key, briefing);
  if (completed.size > 32) completed.delete(completed.keys().next().value!);
  return briefing;
}

export function cachedNoteBriefing(selection: BriefingSelection): NoteBriefing | undefined {
  if (!vaultReady()) return;
  const key = cacheKey(selection), held = completed.get(key);
  if (held) return remember(key, held);
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (value && typeof value.summary === "string" && Array.isArray(value.links)) return remember(key, value);
  } catch { /* Storage can be unavailable or full; memory still works. */ }
}

export function clearNoteBriefingCache(): void {
  completed.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(vaultStorageKey(namespace))) sessionStorage.removeItem(key);
    }
  } catch { /* Unavailable. */ }
}

/** Summary text arrives immediately; relationship targets wait for validation. */
export async function readNoteBriefing(selection: BriefingSelection, preview: (text: string) => void, signal: AbortSignal): Promise<NoteBriefing> {
  const keep = (briefing: NoteBriefing): NoteBriefing => {
    assertVaultCurrent();
    if (!signal.aborted) {
      const key = cacheKey(selection);
      remember(key, briefing);
      try { sessionStorage.setItem(key, JSON.stringify(briefing)); } catch { /* Memory still holds it. */ }
    }
    return briefing;
  };
  const response = await fetch("/api/note/briefing", { method: "POST", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ ...selection, stream: true }) });
  if (!response.ok || !response.headers.get("content-type")?.includes("ndjson")) {
    const body = await response.json();
    if (!response.ok || !body.briefing) throw new Error(body.error ?? "The briefing is unavailable. Try again.");
    return keep(body.briefing);
  }
  if (!response.body) throw new Error("The briefing stream is unavailable.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      assertVaultCurrent();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as NoteBriefingEvent;
        if (event.type === "preview" && !signal.aborted) preview(event.text);
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "complete") return keep(event.briefing);
      }
      if (done) throw new Error("The briefing stopped before it finished. Try again.");
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
