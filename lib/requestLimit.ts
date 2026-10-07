/** requestLimit.ts — one account's budget of requests to a provider, shared by
 * every BigBrain process on this machine: the engine (where Pilot runs) and
 * each MCP client's own server. A bucket of `burst` requests refilled at
 * `perMinute`, and `daily` requests per UTC day (when providers reset theirs),
 * kept in one small private file under a pid lock. It only counts what
 * BigBrain sends: a refusal from the provider is the caller's to report. */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomic } from "./fsx";
import { acquire, release } from "./pidLock";

export interface RequestLimits { burst: number; perMinute: number; daily: number }
interface Budget { version: 1; tokens: number; at: number; day: string; used: number }

function budget(file: string): Budget | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}
const valid = (b: Budget | undefined): b is Budget =>
  b?.version === 1 && [b.tokens, b.at, b.used].every(Number.isFinite) && typeof b.day === "string";

async function locked<T>(lock: string, fn: () => T): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (const deadline = Date.now() + 5_000; !acquire(lock);) {
    if (Date.now() > deadline) throw new LimitError("busy");
    await new Promise(r => setTimeout(r, 5));
  }
  try { return fn(); } finally { release(lock); }
}

/** Why a request was not taken: the day's budget is spent, or the next slot is further off than the caller waits. */
export class LimitError extends Error {
  constructor(readonly reason: "daily" | "busy") { super(reason === "daily" ? "The day's request budget is spent." : "Too many requests at once."); }
}

/** Take one request from the budget kept in `file`, waiting up to `maxWait` ms
 * for the bucket to refill. Throws LimitError when it can't. */
export async function takeRequest(file: string, limits: RequestLimits, o: { signal?: AbortSignal; maxWait?: number; now?: () => number } = {}): Promise<void> {
  const now = o.now ?? Date.now, deadline = now() + (o.maxWait ?? 10_000);
  for (;;) {
    o.signal?.throwIfAborted();
    const wait = await locked(file + ".lock", () => {
      const t = now(), day = new Date(t).toISOString().slice(0, 10), b = budget(file);
      const kept = valid(b) ? b : { version: 1 as const, tokens: limits.burst, at: t, day, used: 0 };
      const tokens = Math.min(limits.burst, kept.tokens + Math.max(0, t - kept.at) * limits.perMinute / 60_000);
      const used = kept.day === day ? kept.used : 0;
      if (used >= limits.daily) return Infinity;
      if (tokens < 1) return Math.ceil((1 - tokens) * 60_000 / limits.perMinute);
      writeAtomic(file, JSON.stringify({ version: 1, tokens: tokens - 1, at: t, day, used: used + 1 } satisfies Budget) + "\n", 0o600);
      return 0;
    });
    if (wait === 0) return;
    if (wait === Infinity) throw new LimitError("daily");
    if (now() + wait > deadline) throw new LimitError("busy");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(o.signal!.reason); };
      const timer = setTimeout(() => { o.signal?.removeEventListener("abort", abort); resolve(); }, wait);
      o.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
