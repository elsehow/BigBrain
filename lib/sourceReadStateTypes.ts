/** Live, per-owner provider state. Never infer it from filing or agent reads,
 * and never freeze it into an immutable source insertion. */
export interface SourceReadState {
  unread: boolean | null;
  provider?: string;
  status: "synced" | "unknown" | "unavailable" | "missing" | "unsupported";
  writable: boolean;
  checkedAt?: string;
}

/** A thread is unread if any member is unread. It is read only when every
 * member is known to be read. Partial coverage must not look like all read. */
export function aggregateReadState(states: SourceReadState[]): SourceReadState {
  if (states.length === 1) return states[0]!;
  const unread = states.some(s => s.unread === true) ? true
    : states.length && states.every(s => s.unread === false) ? false : null;
  const checked = states.map(s => s.checkedAt).filter((s): s is string => !!s).sort();
  return { unread, status: states.length && states.every(s => s.status === "synced") ? "synced" : "unknown",
    writable: !!states.length && states.every(s => s.writable),
    ...(states.length && states.every(s => s.provider === states[0]!.provider) ? { provider: states[0]!.provider } : {}),
    ...(checked.length === states.length ? { checkedAt: checked[0] } : {}) };
}
