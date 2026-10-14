/** Ephemeral invalidations, never an alternative durable application store. */
export interface ApplicationEntityChange { kind: "pilot" | "work"; id: string; revision: number }
export interface ApplicationChange { epoch: string; revision: number; snapshot?: boolean; entities: ApplicationEntityChange[] }
export class ApplicationChanges {
  readonly epoch = crypto.randomUUID();
  private revision = 0;
  private pending = new Map<string, ApplicationEntityChange>();
  private listeners = new Set<(event: ApplicationChange) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  snapshot(): ApplicationChange { return { epoch: this.epoch, revision: this.revision, snapshot: true, entities: [] }; }
  changed(kind: ApplicationEntityChange["kind"], id: string, revision: number): void {
    this.pending.set(`${kind}:${id}`, { kind, id, revision });
    this.timer ??= setTimeout(() => this.flush(), 100);
    this.timer.unref?.();
  }
  /** Also a deterministic seam: tests can deliver a batch without sleeping. */
  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.pending.size) return;
    const event = { epoch: this.epoch, revision: ++this.revision, entities: [...this.pending.values()] };
    this.pending.clear();
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: ApplicationChange) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
