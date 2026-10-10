/**
 * viewStamps.ts — the client's half of `event: views` (lib/viewStamps.ts on
 * the engine): the engine pushes each view's stamp, and a view fetches only
 * when its own stamp has moved past the one it rendered.
 *
 * Plain TS, like live.ts, so `bun test` can reach it.
 */
import type { ViewStamps } from "../../../../lib/viewStamps";
export type { ViewStamps };

/** The stamps a view rendered: from its response (the graph's ETag, the
 * feed's x-bigbrain-stamp), or the pushed stamp it fetched for. "" is none. */
export interface Rendered { graph: string; joined: string; feed: string }

/** Which of the Field's views are behind the pushed stamps. The graph merges
 * in the joined shared vaults, so joining or leaving one moves it too. */
export function viewsBehind(have: Rendered, stamps: ViewStamps): { graph: boolean; feed: boolean } {
  return { graph: stamps.views.graph !== have.graph || stamps.views.joined !== have.joined, feed: stamps.views.feed !== have.feed };
}

/** Whether the views that have no stamp of their own (settings, setup) should
 * re-read: the record or the watched files moved. A first connection is not
 * a move; its views have just loaded. */
export function recordMoved(prev: ViewStamps | null, next: ViewStamps): boolean {
  return !!prev && (prev.generation !== next.generation || prev.revision !== next.revision || prev.views.files !== next.views.files);
}
