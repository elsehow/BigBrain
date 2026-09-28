import { assertionGraphEvidenceAsync } from "./graphCache";
import type { Graph } from "./graph";
import { sha256hex } from "./hash";
import { rankPilotCategories, PILOT_CATEGORY_GRAPH_VERSION } from "./pilotCategoryGraph";
import type { PilotChatSession, PilotCategory } from "./pilotChatTypes";

export interface PilotCategoryOptions {
  graph?: () => Promise<Graph>;
  now?: () => number;
  debounceMs?: number;
}
interface Host { list(): PilotChatSession[]; publish(session: PilotChatSession, category: PilotCategory): void }
const eligible = (s: PilotChatSession) => !s.deactivatedAt && s.messages.some(m => m.role === "user");
// Drafts, prose, titles, status and heartbeats don't change graph evidence.
const evidenceKey = (s: PilotChatSession) => JSON.stringify([
  [...new Set(s.context)].sort(), (s.ingestions ?? []).map(i => [i.path, i.sourceId, i.insertionId]).sort(),
]);

/** Attachment changes classify promptly; maintenance observes graph changes,
 * including during running conversations. Unchanged inputs reuse the persisted
 * result across sweeps and restarts. Menu navigation never does this work. */
export class PilotCategories {
  private pending = new Set<string>();
  private observed = new Map<string, string>();
  private retry = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private refreshing?: Promise<void>;
  private closed = false;
  private read: () => Promise<Graph>;
  private now: () => number;
  constructor(root: string, private host: Host, private options: PilotCategoryOptions = {}) {
    this.read = options.graph ?? (async () => (await assertionGraphEvidenceAsync(root)).graph);
    this.now = options.now ?? Date.now;
  }
  changed(s: PilotChatSession): void {
    if (this.closed || !eligible(s)) return;
    const key = evidenceKey(s);
    if (this.observed.get(s.id) === key) return;
    this.observed.set(s.id, key); this.pending.add(s.id);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.options.debounceMs ?? 500);
    this.timer.unref?.();
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.refreshing ??= (async () => {
      const ids = new Set(this.host.list().map(s => s.id));
      for (const id of this.observed.keys()) if (!ids.has(id)) { this.observed.delete(id); this.retry.delete(id); }
      for (const s of this.host.list()) if (eligible(s)) {
        this.observed.set(s.id, evidenceKey(s)); this.pending.add(s.id);
      }
      await this.flush();
    })().finally(() => { this.refreshing = undefined; });
  }
  private key(s: PilotChatSession, graph: Graph) {
    return sha256hex(JSON.stringify([PILOT_CATEGORY_GRAPH_VERSION, graph.hash, evidenceKey(s)]));
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.closed) return Promise.resolve();
    return this.running ??= this.drain().finally(() => {
      this.running = undefined;
      if (!this.closed && this.pending.size) queueMicrotask(() => { void this.flush(); });
    });
  }
  private async drain(): Promise<void> {
    while (!this.closed && this.pending.size) {
      const id = this.pending.values().next().value!; this.pending.delete(id);
      const s = this.host.list().find(s => s.id === id);
      if (!s || !eligible(s) || (this.retry.get(id) ?? 0) > this.now()) continue;
      try {
        const graph = await this.read();
        if (this.closed) return;
        const key = this.key(s, graph);
        if (s.category?.inputKey === key) continue;
        const result = rankPilotCategories(graph, s);
        const winner = result.winners.length === 1 ? result.winners[0] : undefined;
        const prior = s.category?.memory ? result.memories.find(m => m.id === s.category!.memory || m.path === s.category!.memory) : undefined;
        const memory = winner ?? prior?.id ?? null;
        const reason = winner ? `Graph neighborhood: ${result.ranking[0]!.title}.`
          : prior ? "Kept the previous category: graph evidence is missing or tied."
          : "No unique memory neighborhood is reachable from the attached notes.";
        // Graph or attachments may change during asynchronous shared reads.
        const latest = await this.read(), current = this.host.list().find(s => s.id === id);
        if (this.closed || !current || !eligible(current)) continue;
        if (this.key(current, latest) !== key) { this.pending.add(id); continue; }
        this.host.publish(current, { memory, reason, inputKey: key, model: PILOT_CATEGORY_GRAPH_VERSION, assignedAt: new Date(this.now()).toISOString() });
        this.retry.delete(id);
      } catch (error) {
        if (this.closed) return;
        this.retry.set(id, this.now() + 60_000);
        console.warn(`Graph category (${id}): ${error instanceof Error ? error.message : error}`);
      }
      // Yield between sessions so a backfill doesn't monopolize the viewer.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  close(): void { this.closed = true; clearTimeout(this.timer); this.pending.clear(); }
}
