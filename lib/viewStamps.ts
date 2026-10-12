/** viewStamps.ts — what the viewer pushes when the vault changes
 * (docs/plans/2026-10-10-change-log.md, step 3): one stamp per view, so a
 * client fetches only a view whose stamp moved, and never polls.
 *
 * `generation:revision` is the projection's coordinate. `graph` is the
 * maintained graph view's hash, the ETag /api/graph answers with. `feed` is
 * the coordinate of the last commit the v2 feed reads (every kind but
 * Markdown), the stamp /api/v2 reports in `x-bigbrain-stamp`. `joined` names
 * the shared vaults the Field's graph merges in: joining or leaving one moves
 * it (their own records are read per request, #230). `files` moves
 * when a watched file outside the projection changes (vault.yaml, the queue,
 * a journal): the views that have no stamp of their own re-read on it, and
 * on `revision`. */
import { lastChangeExcept } from "./assertionProjection";
import { graphStamp } from "./maintainedGraph";
import { connectionStorePath, readConnections } from "./sharedConnections";
import { sha256hex } from "./hash";

export interface ViewStamps {
  generation: string;
  revision: string;
  views: { graph: string; joined: string; feed: string; files: string };
}

/** The response header that carries a read model's stamp. */
export const STAMP_HEADER = "x-bigbrain-stamp";

/** What the v2 feed does not read. */
const FEED_IGNORES = ["markdown"] as const;

/** The v2 feed's stamp, in the reader's snapshot when it holds one. */
export function feedStamp(root: string, db?: import("bun:sqlite").Database): string {
  try { return lastChangeExcept(root, FEED_IGNORES, db)?.last ?? ""; } catch { return ""; }
}

export function viewStamps(root: string, files: string): ViewStamps {
  let log: ReturnType<typeof lastChangeExcept>;
  try { log = lastChangeExcept(root, FEED_IGNORES); } catch { /* no projection yet */ }
  const [generation = "", revision = ""] = log?.at.split(":") ?? [];
  let graph = "", joined = "";
  try { graph = graphStamp(root); } catch { /* no view yet */ }
  try {
    const ids = readConnections(connectionStorePath()).map((c) => c.id).sort();
    if (ids.length) joined = sha256hex(ids.join(",")).slice(0, 16);
  } catch { /* an unreadable store joins nothing */ }
  return { generation, revision, views: { graph, joined, feed: log?.last ?? "", files } };
}
