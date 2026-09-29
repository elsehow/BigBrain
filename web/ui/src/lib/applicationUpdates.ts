import type { ApplicationChange, ApplicationEntityChange } from "../../../../lib/applicationChanges";
export interface ViewUpdate { snapshot: boolean; entities: ApplicationEntityChange[] }
/** Per-connection cursor. Snapshots on every connection repair missed final events. */
export class ApplicationCursor {
  epoch = "";
  /** The epoch adopted at the first connection; a later one is a restart. */
  first = "";
  revision = -1;
  connected = false;
  receive(event: ApplicationChange): ViewUpdate | undefined {
    if (!event || typeof event.epoch !== "string" || !Number.isSafeInteger(event.revision) || !Array.isArray(event.entities)) throw new Error("Invalid application update");
    const snapshot = !!event.snapshot || this.epoch !== event.epoch || event.revision > this.revision + 1;
    if (!snapshot && event.revision <= this.revision) return;
    this.first ||= event.epoch;
    this.epoch = event.epoch; this.revision = event.revision; this.connected = true;
    return { snapshot, entities: event.entities };
  }
}
export const applicationCursor = new ApplicationCursor();
/** A request begun before the first connection carries no epoch. The first
 * snapshot adopts one; that is not a restart, so its answer stays current. */
export const applicationResponseCurrent = (epoch: string, cursor = applicationCursor) =>
  epoch === cursor.epoch || (!epoch && cursor.epoch === cursor.first);
/** Serve one request in the application epoch. A read that began before the
 * first connection predates the snapshot's subscription and is read again;
 * an answer from before a restart is refused. */
export async function epochRequest<T>(run: () => Promise<T>, read: boolean, cursor = applicationCursor): Promise<T> {
  const epoch = cursor.epoch;
  const result = await run();
  if (epoch === cursor.epoch) return result;
  if (!epoch && read) return epochRequest(run, read, cursor);
  if (applicationResponseCurrent(epoch, cursor)) return result;
  throw new Error("The engine restarted. Refreshing application views.");
}
const listeners = new Set<(update: ViewUpdate) => void>();
export function receiveApplicationChange(event: ApplicationChange): void {
  const update = applicationCursor.receive(event);
  if (update) for (const fn of listeners) fn(update);
}
export function applicationDisconnected(): void { applicationCursor.connected = false; }
export function subscribeApplication(fn: (update: ViewUpdate) => void): () => void {
  listeners.add(fn);
  if (applicationCursor.connected) fn({ snapshot: true, entities: [] });
  return () => { listeners.delete(fn); };
}
/** Serial drain retains invalidations that arrive during an HTTP request. */
export function updatePump(run: (update: ViewUpdate) => Promise<void>, failed: (error: unknown) => void = () => {}) {
  let snapshot = false, running = false, stopped = false;
  const dirty = new Map<string, ApplicationEntityChange>();
  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && (snapshot || dirty.size)) {
        const next = { snapshot, entities: [...dirty.values()] }; snapshot = false; dirty.clear();
        try { await run(next); } catch (error) { applicationDisconnected(); failed(error); }
      }
    } finally { running = false; }
  };
  return { push(update: ViewUpdate) { snapshot ||= update.snapshot; for (const e of update.entities) dirty.set(`${e.kind}:${e.id}`, e); return drain(); }, stop() { stopped = true; dirty.clear(); } };
}
