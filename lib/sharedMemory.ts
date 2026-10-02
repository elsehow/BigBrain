/** What the memory pass knows of the shared vaults this machine has joined.
 *
 * Memory folds the union of every vault the user can read, not only the one
 * on disk. The shared ones answer over HTTP, so one async refresh per tend
 * tick writes `.state/shared-memory.json`, and everything that must agree
 * reads that one file synchronously: the due check and the queue view
 * (lib/memory.ts), the run's context and citation gate (lib/memoryRun.ts),
 * and its tools (lib/run/machineTools.ts). A cache like the rest of .state:
 * delete it and the next tick fetches it again.
 *
 * A refresh costs one feed request per vault when nothing changed; only a
 * moved feed head pages the vault's assertions and source titles. A vault
 * that cannot be reached keeps its last view, so a network blip neither
 * reverts a run nor reads as a correction. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeAtomic } from "./fsx";
import { connectionStorePath, readConnections, sharedRequest, type SharedConnection } from "./sharedConnections";
import type { AssertionView } from "./sharedVault";
import type { SourceMetadata } from "./insertionLog";

export interface SharedMemoryAssertion {
  id: string;
  text: string;
  entities: { id: string; label: string }[];
  /** shared insertion ids */
  sources: string[];
  confidence: string;
  created_at: string;
  author: { kind: string; id: string };
  revoked?: true;
}

export interface SharedMemoryVault {
  /** this machine's connection id — the middle of `[[shared:<id>:ast_…]]` */
  id: string;
  name: string;
  /** the feed head this view was read at; -1 before the first read */
  head: number;
  reachable: boolean;
  assertions: SharedMemoryAssertion[];
  /** shared insertion id → title, for the run context's source lines */
  titles: Record<string, string>;
}

export interface SharedMemory { vaults: SharedMemoryVault[] }

/** What one run observed of one vault: its feed head and live assertion ids. */
export interface SharedCheckpoint { head: number; assertions: string[] }

export const sharedCite = (vault: string, assertion: string): string => `shared:${vault}:${assertion}`;
export const sharedSourcePath = (vault: string, insertion: string): string => `shared/${vault}/${insertion}.md`;

const cacheFile = (root: string): string => join(root, ".state", "shared-memory.json");

export function readSharedMemory(root: string): SharedMemory {
  try {
    const value = JSON.parse(readFileSync(cacheFile(root), "utf8")) as SharedMemory;
    if (Array.isArray(value?.vaults)) return value;
  } catch { /* absent or unreadable: no shared vaults known yet */ }
  return { vaults: [] };
}

async function pages<T>(c: SharedConnection, path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: T[]; next_cursor: string | null } =
      await sharedRequest(c, `${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

const slim = ({ assertion: a, revocation }: AssertionView): SharedMemoryAssertion => ({
  id: a.id, text: a.text, entities: a.entities.map(({ id, label }) => ({ id, label })),
  sources: (a.sources ?? a.citations ?? []).map((s) => s.insertion_id),
  confidence: a.confidence, created_at: a.created_at, author: { kind: a.author.kind, id: a.author.id },
  ...(revocation ? { revoked: true as const } : {}),
});

async function readVault(c: SharedConnection, cached: SharedMemoryVault | undefined): Promise<SharedMemoryVault> {
  try {
    const { head } = await sharedRequest<{ head: number }>(c, "/v1/feed?limit=1");
    if (cached && cached.head === head) return { ...cached, name: c.name, reachable: true };
    // Revoked assertions are kept, marked: memory may still cite one until
    // its next run reconciles, exactly as the personal gate allows.
    const [views, evidence] = await Promise.all([
      pages<AssertionView>(c, "/v1/assertions?include_revoked=1"),
      pages<SourceMetadata>(c, "/v1/evidence"),
    ]);
    return { id: c.id, name: c.name, head, reachable: true, assertions: views.map(slim),
      titles: Object.fromEntries(evidence.map((e) => [e.id, e.title])) };
  } catch {
    return cached ? { ...cached, name: c.name, reachable: false }
      : { id: c.id, name: c.name, head: -1, reachable: false, assertions: [], titles: {} };
  }
}

/** Re-read every joined vault whose feed moved, and write the cache. */
export async function refreshSharedMemory(root: string, store: string = connectionStorePath()): Promise<SharedMemory> {
  const cached = new Map(readSharedMemory(root).vaults.map((v) => [v.id, v]));
  const connections = existsSync(store) ? readConnections(store) : [];
  if (!connections.length && !cached.size) return { vaults: [] };
  const memory = { vaults: await Promise.all(connections.map((c) => readVault(c, cached.get(c.id)))) };
  ensureDir(join(root, ".state"));
  writeAtomic(cacheFile(root), JSON.stringify(memory) + "\n");
  return memory;
}

export interface SharedFresh { vault: SharedMemoryVault; assertion: SharedMemoryAssertion }

/** The shared half of a memory run's delta against its checkpoint: live
 * assertions no earlier run observed, the checkpoint this run would record,
 * and whether anything an earlier run relied on went away (a revocation, a
 * disconnected vault). A vault never read yet is left for a later tick. */
export function sharedMemoryDelta(
  memory: SharedMemory,
  prior: Record<string, SharedCheckpoint> | undefined
): { fresh: SharedFresh[]; checkpoint: Record<string, SharedCheckpoint>; recordChanged: boolean } {
  const fresh: SharedFresh[] = [];
  const checkpoint: Record<string, SharedCheckpoint> = {};
  const joined = new Set(memory.vaults.map((v) => v.id));
  let recordChanged = Object.keys(prior ?? {}).some((id) => !joined.has(id));
  for (const vault of memory.vaults) {
    const before = prior?.[vault.id];
    if (vault.head < 0) { if (before) checkpoint[vault.id] = before; continue; }
    const live = vault.assertions.filter((a) => !a.revoked);
    const seen = new Set(before?.assertions);
    for (const assertion of live) if (!seen.has(assertion.id)) fresh.push({ vault, assertion });
    const now = new Set(live.map((a) => a.id));
    if (before?.assertions.some((id) => !now.has(id))) recordChanged = true;
    checkpoint[vault.id] = { head: vault.head, assertions: live.map((a) => a.id) };
  }
  return { fresh, checkpoint, recordChanged };
}

/** The shared citations a memory tree may not keep: ones naming a vault this
 * machine no longer joins, or an assertion a read vault does not hold. A
 * vault never read yet is not judged — the network is not evidence. */
export function unknownSharedCitations(memory: SharedMemory, cited: Iterable<[vault: string, assertion: string]>): string[] {
  const views = new Map(memory.vaults.map((v) => [v.id, { unread: v.head < 0, held: new Set(v.assertions.map((a) => a.id)) }]));
  const unknown: string[] = [];
  for (const [vault, assertion] of cited) {
    const view = views.get(vault);
    if (!view?.unread && !view?.held.has(assertion)) unknown.push(sharedCite(vault, assertion));
  }
  return [...new Set(unknown)].sort();
}
