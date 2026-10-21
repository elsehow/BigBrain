import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tryHold } from "../sqliteLock";

/** FIFO admission within a process. Aborting removes waiting work. Once
 * started, the task owns cancellation. */
export class QuickQueue {
  private active = 0;
  private waiting = new Set<() => void>();

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Quick concurrency must be a positive integer.");
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const cancel = () => {
        this.waiting.delete(start);
        reject(signal!.reason);
      };
      const finish = () => { this.active--; this.drain(); };
      const start = () => {
        signal?.removeEventListener("abort", cancel);
        this.active++;
        Promise.resolve().then(task).then(
          value => { finish(); resolve(value); },
          error => { finish(); reject(error); },
        );
      };
      this.waiting.add(start);
      signal?.addEventListener("abort", cancel, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.waiting.size) {
      const next = this.waiting.values().next().value!;
      this.waiting.delete(next);
      next();
    }
  }
}

export const QUICK_CONCURRENCY = 2;
export const quickQueue = new QuickQueue(QUICK_CONCURRENCY);

/** The viewer, background chains and CLI share the SAME two slots per
 * vault. SQLite releases a slot on process death, with no stale PID/lease
 * recovery. Waiting holds no model session and has no generation timeout.
 * These lock files must never be unlinked while an engine is running. */
export async function withQuickSlot<T>(root: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    for (let i = 0; i < QUICK_CONCURRENCY; i++) {
      const hold = tryHold(join(root, ".state", "quick-slots", `${i}.sqlite`));
      if (!hold) continue;
      try { signal?.throwIfAborted(); return await task(); }
      finally { hold.release(); }
    }
    try { await delay(50, undefined, { signal }); }
    catch { signal?.throwIfAborted(); throw new Error("Could not wait for Quick capacity."); }
  }
}
