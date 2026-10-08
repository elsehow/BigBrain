/** requestLimit.ts — one account's budget of requests to a provider, shared by
 * every BigBrain process on this machine: the engine (where Pilot runs) and
 * each MCP client's own server. A bucket of `burst` requests refilled at
 * `perMinute`, and `daily` requests per UTC day (when providers reset theirs),
 * kept in a small private SQLite file and changed only under its lock
 * (lib/sqliteLock.ts). It only counts what BigBrain sends: a refusal from the
 * provider is the caller's to report. */
import { lockBusy, withLockedDatabase } from "./sqliteLock";

export interface RequestLimits { burst: number; perMinute: number; daily: number }
interface Budget { tokens: number; at: number; day: string; used: number }
/** Another process holds the budget for an instant at most; waiting longer than this means something is wrong. */
const WAIT = 2_000;

/** Why a request was not taken: the day's budget is spent, or the next slot is further off than the caller waits. */
export class LimitError extends Error {
  constructor(readonly reason: "daily" | "busy") { super(reason === "daily" ? "The day's request budget is spent." : "Too many requests at once."); }
}

/** One request from the budget in `file` at `t`: 0 when taken, else how long until the next (Infinity: not today). */
function take(file: string, limits: RequestLimits, t: number): number {
  try {
    return withLockedDatabase(file, db => {
      db.run("CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK (id = 1), tokens REAL NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL)");
      const day = new Date(t).toISOString().slice(0, 10);
      const kept = db.query("SELECT tokens, at, day, used FROM budget WHERE id = 1").get() as Budget | null ?? { tokens: limits.burst, at: t, day, used: 0 };
      const tokens = Math.min(limits.burst, kept.tokens + Math.max(0, t - kept.at) * limits.perMinute / 60_000);
      const used = kept.day === day ? kept.used : 0;
      if (used >= limits.daily) return Infinity;
      if (tokens < 1) return Math.ceil((1 - tokens) * 60_000 / limits.perMinute);
      db.query("INSERT OR REPLACE INTO budget (id, tokens, at, day, used) VALUES (1, ?, ?, ?, ?)").run(tokens - 1, t, day, used + 1);
      return 0;
    }, WAIT);
  } catch (error) {
    if (lockBusy(error)) throw new LimitError("busy");
    throw error;
  }
}

/** Take one request from the budget kept in `file`, waiting up to `maxWait` ms
 * for the bucket to refill. Throws LimitError when it can't. */
export async function takeRequest(file: string, limits: RequestLimits, o: { signal?: AbortSignal; maxWait?: number; now?: () => number } = {}): Promise<void> {
  const now = o.now ?? Date.now, deadline = now() + (o.maxWait ?? 10_000);
  for (;;) {
    o.signal?.throwIfAborted();
    const wait = take(file, limits, now());
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
