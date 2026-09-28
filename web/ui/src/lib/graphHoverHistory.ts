/** Depth history only: never changes selection, labels, edges, or membership. */
export class GraphHoverHistory {
  private visits = new Map<string, number>();
  private generation = 0;
  private leftAt: number | null = null;
  private previous = new Map<string, number>();
  private changedAt = 0;
  private previousStrength = 0;
  private returning = false;
  readonly holdMs = 2500;
  readonly returnMs = 1800;

  clear(): void {
    this.visits.clear(); this.previous.clear(); this.generation = 0;
    this.leftAt = null; this.returning = false;
  }
  private level(id: string): number {
    const visit = this.visits.get(id);
    return visit === undefined ? -80 : visit === this.generation ? 0 : -Math.min(13, (this.generation - visit) * 3.5);
  }
  enter(ids: readonly string[], allIds: readonly string[], now: number): void {
    const state = this.sample(allIds, now);
    const current = state.offsets;
    this.previousStrength = state.strength;
    this.previous = new Map(allIds.map((id, i) => [id, current[i]!]));
    this.generation++;
    for (const id of ids) this.visits.set(id, this.generation);
    this.leftAt = null; this.changedAt = now; this.returning = false;
  }
  leave(now: number): void { if (this.generation) this.leftAt = now; }
  sample(ids: readonly string[], now: number): { offsets: Float32Array; strength: number; moving: boolean } {
    if (!this.generation) return { offsets: new Float32Array(ids.length), strength: 0, moving: false };
    const returnStart = this.leftAt === null ? Infinity : this.leftAt + this.holdMs;
    if (now >= returnStart + this.returnMs) {
      this.clear(); return { offsets: new Float32Array(ids.length), strength: 0, moving: false };
    }
    this.returning = now >= returnStart;
    const t = Math.min(1, Math.max(0, (now - this.changedAt) / 350));
    const ease = (1 - Math.cos(Math.PI * t)) / 2;
    const release = this.returning ? (1 + Math.cos(Math.PI * (now - returnStart) / this.returnMs)) / 2 : 1;
    return { offsets: Float32Array.from(ids, id => ((this.previous.get(id) ?? 0) * (1 - ease) + this.level(id) * ease) * release),
      strength: (this.previousStrength * (1 - ease) + ease) * release,
      moving: t < 1 || this.returning };
  }
}
