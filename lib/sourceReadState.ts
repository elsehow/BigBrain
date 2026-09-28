import type { SourceMetadata } from "./insertionLog";
import { insertionEventRel } from "./insertionLog";
import { sourceCatalog, sourceReadTargets } from "./vaultReadModel";
import { sourceThreads } from "./sourceThreads";
import { supersededInsertionIds } from "./sourceSupersede";
import { aggregateReadState, type SourceReadState } from "./sourceReadStateTypes";
export type { SourceReadState } from "./sourceReadStateTypes";

/** Integration boundary: adapters resolve immutable source identity to LIVE
 * provider state. Reads have no side effects. Writes set (never toggle), await
 * provider confirmation, and return the observed state. Credentials stay in
 * the integration. New integrations implement this contract, not a UI branch. */
export interface SourceReadStateAdapter {
  provider: string;
  available?: (root: string) => boolean;
  supports(source: SourceMetadata): boolean;
  read(root: string, sources: SourceMetadata[]): Promise<Map<string, SourceReadState>>;
  setUnread(root: string, source: SourceMetadata, unread: boolean): Promise<SourceReadState>;
}
export interface SourceReadStateRow { path: string; title: string; readState: SourceReadState }
const unsupported = (): SourceReadState => ({ unread: null, status: "unsupported", writable: false });

export function createSourceReadStateService(adapters: SourceReadStateAdapter[], options: {
  sources?: (root: string) => SourceMetadata[]; now?: () => number; ttlMs?: number;
} = {}) {
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? 60_000;
  const cache = new Map<string, { at: number; states: Map<string, SourceReadState> }>();
  const pending = new Map<string, Promise<unknown>>();
  const catalog = (root: string) => {
    if (!options.sources) return sourceCatalog(root);
    const all = options.sources(root), hidden = supersededInsertionIds(all);
    const sources = all.filter(s => !hidden.has(s.id));
    return { sources, threads: sourceThreads(sources) };
  };
  const adapter = (s: SourceMetadata) => adapters.find(a => a.supports(s));
  // Serialize refreshes and mutations so a slow pre-write read cannot replace
  // a confirmed write. A failure leaves the lane usable for the next request.
  function serial<T>(root: string, run: () => Promise<T>): Promise<T> {
    const task = (pending.get(root) ?? Promise.resolve()).catch(() => {}).then(run);
    pending.set(root, task);
    void task.finally(() => { if (pending.get(root) === task) pending.delete(root); }).catch(() => {});
    return task;
  }
  function state(root: string, source: SourceMetadata): SourceReadState {
    const a = adapter(source);
    if (!a) return unsupported();
    if (a.available && !a.available(root)) return {unread:null,provider:a.provider,status:"unavailable",writable:false};
    const entry = cache.get(root), held = entry?.states.get(source.id);
    if (held && now() - entry!.at < ttl) return held;
    return { unread: null, provider: a.provider, status: "unknown", writable: false, ...(held?.checkedAt ? { checkedAt: held.checkedAt } : {}) };
  }
  function rows(root: string, { sources: all, threads } = catalog(root)): SourceReadStateRow[] {
    const result = all.map(s => ({ path: insertionEventRel(s), title: s.title, readState: state(root, s) }));
    const byId = new Map(all.map(s => [s.id, state(root, s)]));
    for (const thread of threads) result.push({ path: thread.path, title: thread.title,
      readState: aggregateReadState(thread.members.map(s => byId.get(s.id)!)) });
    return result;
  }
  async function refresh(root: string, force = false): Promise<SourceReadStateRow[]> {
    return serial(root, async () => {
      const view = catalog(root), all = view.sources, held = cache.get(root);
      if (!force && held && now() - held.at < ttl && all.every(s => !adapter(s) || held.states.has(s.id))) return rows(root, view);
      const states = new Map<string, SourceReadState>();
      for (const a of adapters) {
        const supported = all.filter(s => adapter(s) === a);
        if (!supported.length || a.available && !a.available(root)) continue;
        try {
          const observed = await a.read(root, supported);
          for (const s of supported) states.set(s.id, observed.get(s.id) ?? { unread: null, provider: a.provider, status: "unknown", writable: false });
        } catch {
          for (const s of supported) states.set(s.id, { unread: null, provider: a.provider, status: "unavailable", writable: false });
        }
      }
      cache.set(root, { at: now(), states });
      return rows(root, view);
    });
  }
  async function setUnread(root: string, paths: unknown, unread: unknown, action?: { actions: import("./applicationActions").ApplicationActions; request: string; actor: import("./applicationActions").ActionActor }) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(p => typeof p !== "string") || typeof unread !== "boolean")
      throw new Error("Provide 1–100 source paths and an explicit unread boolean.");
    return serial(root, async () => {
      let byPath: Map<string, SourceMetadata[]>;
      if (options.sources) {
        const { sources, threads } = catalog(root);
        byPath = new Map(sources.map(s => [insertionEventRel(s), [s]]));
        for (const t of threads) for (const path of [t.path, ...t.aliases]) byPath.set(path, t.members);
      } else byPath = sourceReadTargets(root, paths);
      // Validate every target before the first external write.
      const selected = [...new Map(paths.flatMap(path => {
        const items = byPath.get(path);
        if (!items) throw new Error("Source not found. Refresh the selection before changing read state.");
        if (items.some(s => !adapter(s))) throw new Error("This source does not support provider read state.");
        return items.map(s => [s.id, s] as const);
      })).values()];
      if (selected.length > 100) throw new Error("This selection contains more than 100 messages. Use smaller batches.");
      const results: Array<SourceReadStateRow & { ok: boolean; error?: string }> = [];
      const held = cache.get(root);
      for (const source of selected) {
        const a = adapter(source)!;
        try {
          const observed = action ? await action.actions.execute({ actor: action.actor, request: `${action.request}:${source.id}`, operation: "source_set_unread.item",
            scope: [insertionEventRel(source)], payload: { source: source.id, unread } }, {
              authorize: () => { if (a.available && !a.available(root)) throw new Error("Provider is unavailable."); },
              execute: () => a.setUnread(root, source, unread),
            }) : await a.setUnread(root, source, unread);
          held?.states.set(source.id, observed);
          results.push({ path: insertionEventRel(source), title: source.title, readState: observed,
            ok: observed.status === "synced" && observed.unread === unread });
        } catch {
          const unknown: SourceReadState = { unread: null, provider: a.provider, status: "unavailable", writable: false };
          held?.states.set(source.id, unknown);
          results.push({ path: insertionEventRel(source), title: source.title, readState: unknown, ok: false,
            error: "Provider did not confirm the change. Refresh read state before retrying." });
        }
      }
      // Refresh next time; successful writes never refresh unrelated old flags.
      cache.delete(root);
      return { results, ok: results.every(r => r.ok) };
    });
  }
  return { refresh, peek: rows, setUnread };
}
