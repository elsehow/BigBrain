/**
 * frozenQueue.ts — TOLERANT READ over the retired queue trees (#498).
 *
 * The stored queue (`queue/{pending,running,done,failed}/<id>.yaml`) died
 * with the editor pass: nothing writes it, nothing moves it, and new work
 * is a view over the logs (lib/work.ts). But the trees on old vaults are
 * FROZEN HISTORY (design-principles §5 — no migrations): the memory
 * pass's legacy done-cursor, the viewer's note-side directive history,
 * and the graph's declined-set all still read them. This module is that
 * read — and only that: no emitters, no state machine, no locks. A vault
 * born after the cut has no queue/ and every function here answers empty.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { QUEUE_STATES, type QueueState } from "./viewTypes";

export type { QueueState } from "./viewTypes";

/** A frozen message, exactly as the emitters left it. Every field beyond
 * `id`/`refs` is optional — this is an archaeological read, not a schema. */
export interface FrozenQueueMessage {
  id: string;
  refs: string[];
  insertion_id?: string;
  guidance?: string;
  facts?: Record<string, unknown>;
  params?: Record<string, unknown>;
  verb?: string;
  from?: string;
  via?: string;
  from_kind?: string;
  enqueued?: string;
  finished?: string;
  run?: string;
  outcome?: string;
  error?: string;
  attempts?: number;
  [key: string]: unknown;
}

export interface FrozenQueueEntry {
  state: QueueState;
  /** Vault-relative, `queue/<state>/<id>.yaml`. */
  path: string;
  message: FrozenQueueMessage;
}

const stateDir = (root: string, state: QueueState): string => join(root, "queue", state);

/** One frozen message, or null — a torn or prose file in a frozen tree is
 * history's problem, never a reader's throw. */
function readFrozenMessage(path: string): FrozenQueueMessage | null {
  try {
    const doc = parse(readFileSync(path, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    const msg = doc as FrozenQueueMessage;
    if (typeof msg.id !== "string") return null;
    if (!Array.isArray(msg.refs)) msg.refs = [];
    return msg;
  } catch {
    return null;
  }
}

/** Every frozen message in one state (or all four, pending→failed order).
 * Timestamped ids make the per-state sort chronological. */
export function listFrozenMessages(root: string, state?: QueueState): FrozenQueueEntry[] {
  const states: readonly QueueState[] = state ? [state] : QUEUE_STATES;
  const out: FrozenQueueEntry[] = [];
  for (const s of states) {
    const dir = stateDir(root, s);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)
      .filter((name) => name.endsWith(".yaml"))
      .sort()) {
      const message = readFrozenMessage(join(dir, f));
      if (message) out.push({ state: s, path: ["queue", s, f].join("/"), message });
    }
  }
  return out;
}

/** Every frozen message naming one of `keys` (a reference id or a
 * vault-relative path — refs carried both vocabularies). Exact match
 * only, empty keys match nothing — the retired reader's exact rule. */
export function frozenMessagesForRefs(root: string, keys: readonly string[]): FrozenQueueEntry[] {
  const wanted = new Set(keys.filter(Boolean));
  if (!wanted.size) return [];
  return listFrozenMessages(root).filter((e) => e.message.refs.some((r) => wanted.has(r)));
}

/** Reference ids the EDITOR ERA finished with — every ref named in
 * `queue/done/` (absorbed and declined both; `failed/` excluded, exactly
 * as the live reader excluded the dead-letter tree). The graph unions
 * this with the decline log's projection — the era's two decline
 * vocabularies, one answer. */
export function settledFrozenRefIds(root: string): Set<string> {
  const out = new Set<string>();
  for (const e of listFrozenMessages(root, "done")) for (const r of e.message.refs) out.add(r);
  return out;
}

/** Newest-enqueued-first — ISO `enqueued` strings sort without a parse. */
export function sortFrozenDesc(entries: FrozenQueueEntry[]): FrozenQueueEntry[] {
  return [...entries].sort((a, b) =>
    (b.message.enqueued ?? "").localeCompare(a.message.enqueued ?? "")
  );
}
