/**
 * serverStore.ts — each joined server, held on this computer
 * (docs/plans/2026-10-11-field-of-assertions.md, step 6;
 * docs/plans/2026-10-12-stages-and-views-refactor.md, R8).
 *
 * A follower (`followServer`, run by the supervisor's `servers` job,
 * bin/servers.ts) watches each server's change feed and, when its head has
 * moved, pages its evidence and claims into a store beside the connection
 * credentials, outside every vault, with the body of each landing it has
 * not held before. Landings never change, so a body is fetched once.
 *
 * Every read of a joined server reads the store: no read waits on the
 * network, and a server that is down shows what it last said, with when and
 * why it stopped answering, instead of vanishing. The store is disposable:
 * deleting it costs one full fetch.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "./fsx";
import type { SourceInsertion } from "./insertionLog";
import type { SourceMetadata } from "./insertionLog";
import { readConnections, SharedConnectionError, sharedRequest, type SharedConnection, type SharedIdentity } from "./sharedConnections";
import type { AssertionView } from "./sharedVault";
import type { IdentityAssertion } from "./assertionLog";

/** A server's evidence as its list gives it: no bodies. */
export type SharedSource = SourceMetadata & { body?: string; submitted_at?: string };

export interface ServerSnapshot {
  /** The feed head this was paged at. */
  head: number;
  evidence: SharedSource[];
  assertions: AssertionView[];
  /** Which landings are one work, or an entity (step 7); none from a server that holds none. */
  identities?: IdentityAssertion[];
}

export interface ServerStatus {
  /** When the follower last heard from it, and what it said it is. */
  syncedAt?: string;
  head?: number;
  name?: string;
  permissions?: string[];
  /** Why the last attempt failed; the snapshot before it still stands. */
  error?: { message: string; at: string };
}

/** Bodies fetched a tick, at most: a large server fills in over ticks. */
const BODIES_PER_TICK = 200;

const dirOf = (store: string, id: string) => {
  if (!/^[A-Za-z0-9-]+$/u.test(id)) throw new Error("Unknown server.");
  return join(dirname(store), "servers", id);
};
const readJson = <T>(path: string): T | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
};
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeAtomic(path, JSON.stringify(value), 0o600); };

/** What this computer holds of a server, and how its last sync went. */
export function readServer(store: string, id: string): { snapshot?: ServerSnapshot; status: ServerStatus } {
  const dir = dirOf(store, id);
  const snapshot = readJson<ServerSnapshot>(join(dir, "snapshot.json"));
  return { ...(snapshot ? { snapshot } : {}), status: readJson<ServerStatus>(join(dir, "status.json")) ?? {} };
}

/** A landing's body as the follower fetched it; undefined until it has. */
export function serverBody(store: string, id: string, insertionId: string): string | undefined {
  if (!/^ins_[a-f0-9]{24}$/u.test(insertionId)) return undefined;
  return readJson<{ body: string }>(join(dirOf(store, id), "bodies", `${insertionId}.json`))?.body;
}

const watchers = new Map<string, { listeners: Set<() => void>; close: () => void }>();
/** Hear a server's store change on this computer, as its follower writes it:
 * one watch a server, however many windows listen. Returns the unsubscribe. */
export function onServerChange(store: string, id: string, listener: () => void): () => void {
  const dir = dirOf(store, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let w = watchers.get(dir);
  if (!w) {
    const listeners = new Set<() => void>(), fw = watch(dir, () => { for (const l of listeners) l(); });
    w = { listeners, close: () => fw.close() };
    watchers.set(dir, w);
  }
  const held = w;
  held.listeners.add(listener);
  return () => { held.listeners.delete(listener); if (!held.listeners.size) { held.close(); watchers.delete(dir); } };
}

/** Hear any joined server's store change: what the viewer pushes on. A
 * server joined later is watched from its first sync. Returns the stop. */
export function watchServers(store: string, onChange: () => void): () => void {
  const root = join(dirname(store), "servers");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const subs = new Map<string, () => void>();
  const sync = () => {
    const ids = new Set(readConnections(store).map((c) => c.id));
    for (const id of ids) if (!subs.has(id)) subs.set(id, onServerChange(store, id, onChange));
    for (const [id, stop] of subs) if (!ids.has(id)) { stop(); subs.delete(id); }
  };
  const top = watch(root, () => { sync(); onChange(); });
  sync();
  return () => { top.close(); for (const stop of subs.values()) stop(); };
}

/** Bring one server's store up to its feed head. Never throws: a failure is
 * written to its status, and what it held stands. */
export async function followServer(store: string, c: SharedConnection): Promise<ServerStatus> {
  const dir = dirOf(store, c.id), at = new Date().toISOString();
  const before = readServer(store, c.id);
  try {
    const who = await sharedRequest<SharedIdentity>(c, "/v1/whoami");
    if (!who.permissions.includes("read")) throw new Error("Read access has been removed.");
    const { head } = await sharedRequest<{ head: number }>(c, "/v1/feed?after=0&limit=1");
    if (before.snapshot?.head !== head) {
      const [evidence, assertions, identities] = await Promise.all([pages<SharedSource>(c, "evidence"), pages<AssertionView>(c, "assertions"),
        // a server from before identity holds none: its 404 is an empty list
        pages<IdentityAssertion>(c, "identities").catch((e) => { if (e instanceof SharedConnectionError && e.status === 404) return []; throw e; })]);
      write(join(dir, "snapshot.json"), { head, evidence, assertions, identities } satisfies ServerSnapshot);
    }
    const snapshot = readServer(store, c.id).snapshot!;
    let fetched = 0;
    for (const s of snapshot.evidence) {
      if (fetched >= BODIES_PER_TICK) break;
      if (serverBody(store, c.id, s.id) !== undefined) continue;
      const full = await sharedRequest<SourceInsertion>(c, `/v1/evidence/${s.id}`);
      write(join(dir, "bodies", `${s.id}.json`), { body: full.body });
      fetched++;
    }
    const status: ServerStatus = { syncedAt: at, head, permissions: who.permissions, ...(who.vault?.name ? { name: who.vault.name } : {}) };
    write(join(dir, "status.json"), status);
    return status;
  } catch (error) {
    // Access gone (a revoked credential, a removed member): what this computer
    // held of the server goes with it, and every read is refused.
    const refused = error instanceof SharedConnectionError && (error.status === 401 || error.status === 403)
      || (error instanceof Error && error.message === "Read access has been removed.");
    if (refused) for (const held of ["snapshot.json", "bodies"]) rmSync(join(dir, held), { recursive: true, force: true });
    const status: ServerStatus = { ...before.status, ...(refused ? { permissions: [] } : {}),
      error: { message: error instanceof Error ? error.message : String(error), at } };
    write(join(dir, "status.json"), status);
    return status;
  }
}

/** Follow every joined server, and let go of the stores of servers no longer joined. */
export async function followServers(store: string): Promise<void> {
  const connections = readConnections(store);
  await Promise.all(connections.map((c) => followServer(store, c)));
  const root = join(dirname(store), "servers");
  if (!existsSync(root)) return;
  const joined = new Set(connections.map((c) => c.id));
  for (const id of readdirSync(root)) if (!joined.has(id)) rmSync(join(root, id), { recursive: true, force: true });
}

/** Every row of one of a server's paged lists (`/v1/evidence`, `/v1/assertions`). */
export async function pages<T>(c: SharedConnection, kind: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const p: { items: T[]; next_cursor: string | null } = await sharedRequest(c, `/v1/${kind}?limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    rows.push(...p.items);
    cursor = p.next_cursor;
  } while (cursor);
  return rows;
}
