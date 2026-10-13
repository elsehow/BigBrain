/** viewStamps.ts — what the viewer pushes when the vault changes
 * (docs/plans/2026-10-10-change-log.md, step 3): one stamp per view, so a
 * client fetches only a view whose stamp moved, and never polls.
 *
 * `generation:revision` is the projection's coordinate. `graph` is the
 * maintained graph view's hash, the ETag /api/graph answers with. `feed` is
 * the coordinate of the last commit the v2 feed reads, the stamp /api/v2
 * reports in `x-bigbrain-stamp`; `folds` is the same for the fold proposals
 * (/api/entity/folds). `joined` names
 * the shared vaults the Field's graph merges in: joining or leaving one, or
 * its follower landing a new head (lib/serverStore.ts), moves it. `files` moves
 * when a watched file outside the projection changes (vault.yaml, the queue,
 * a journal): the views that have no stamp of their own re-read on it, and
 * on `revision`. */
import type { Database } from "bun:sqlite";
import type { ServerResponse } from "node:http";
import { lastChangeExcept, type ChangeKind } from "./assertionProjection";
import { json } from "./httpx";
import { graphStamp } from "./maintainedGraph";
import { connectionStorePath, readConnections } from "./sharedConnections";
import { readServer } from "./serverStore";
import { sha256hex } from "./hash";
import { withSnapshot } from "./vaultReadModel";
import type { Snapshot } from "./views/view";

export interface ViewStamps {
  generation: string;
  revision: string;
  views: { graph: string; joined: string; feed: string; folds: string; files: string };
}

/** The response header that carries a read model's stamp. */
export const STAMP_HEADER = "x-bigbrain-stamp";

/** What each view does not read: a commit of only these leaves its stamp. */
const FEED_IGNORES: readonly ChangeKind[] = ["markdown", "fold_reject", "folds", "inclusion"];
const FOLDS_IGNORES: readonly ChangeKind[] = ["markdown", "journal", "decline", "entity_source", "copy", "inclusion"];

const stampOf = (ignores: readonly ChangeKind[]) => (root: string, db?: Database): string => {
  try { return lastChangeExcept(root, ignores, db)?.last ?? ""; } catch { return ""; }
};
/** The v2 feed's stamp, in the reader's snapshot when it holds one. */
export const feedStamp = stampOf(FEED_IGNORES);
/** The fold proposals' stamp, likewise. */
export const foldsStamp = stampOf(FOLDS_IGNORES);

/** A read model from one snapshot, with the stamp it was read at. */
export function serveStamped<T>(res: ServerResponse, root: string, stamp: (root: string, db: Database) => string,
  read: (snapshot: Snapshot, stamp: string) => T): void {
  try {
    const [at, value] = withSnapshot(root, (snapshot) => {
      const at = stamp(root, snapshot.db);
      return [at, read(snapshot, at)] as const;
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", [STAMP_HEADER]: at });
    res.end(JSON.stringify(value));
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Each view's stamp: the projection's from one snapshot, so no two can
 * straddle a commit; the graph's as the maintainer holds it; the joined
 * servers' as this computer holds them; `files` as the watcher chained it. */
export function viewStamps(root: string, files: string): ViewStamps {
  let log: ReturnType<typeof lastChangeExcept>, folds = "";
  try {
    [log, folds] = withSnapshot(root, ({ db }) => [lastChangeExcept(root, FEED_IGNORES, db), foldsStamp(root, db)] as const);
  } catch { /* no projection yet */ }
  const [generation = "", revision = ""] = log?.at.split(":") ?? [];
  let graph = "", joined = "";
  try { graph = graphStamp(root); } catch { /* no view yet */ }
  try {
    // which servers are joined, and how far this computer's copy of each has come
    const store = connectionStorePath();
    const held = readConnections(store).map((c) => c.id).sort().map((id) => { const { snapshot, status } = readServer(store, id); return `${id}:${snapshot?.head ?? ""}:${status.error?.at ?? ""}`; });
    if (held.length) joined = sha256hex(held.join(",")).slice(0, 16);
  } catch { /* an unreadable store joins nothing */ }
  return { generation, revision, views: { graph, joined, feed: log?.last ?? "", folds, files } };
}
