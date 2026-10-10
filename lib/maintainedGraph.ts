/** The graph as a view kept by its maintainer, not built per request
 * (docs/plans/2026-10-10-change-log.md, step 2).
 *
 * One build per vault at a time, in a worker, whenever the projection's
 * revision has moved past the view's; a build that finishes behind the
 * projection runs again. Readers get the last view at once — a request is a
 * lookup — and a start serves the view saved last session when nothing
 * changed while the app was closed. A journal write never moves the revision,
 * so it never rebuilds the graph. Briefing evidence is not part of the view;
 * its readers still prepare it (graphCache.assertionGraphEvidenceAsync). */
import type { Graph } from "./graph";
import { buildAssertionGraph } from "./assertionGraph";
import { projectionView, saveProjectionView, type ProjectionView } from "./assertionProjection";
import { EMPTY_GRAPH, graphWithLayout } from "./graphCache";
import { background } from "./readModelBackground";
import { recentSourcePage } from "./sourceFeed";
import { readModelRevision, vaultRecord, withVaultSnapshot } from "./vaultReadModel";

const NAME = "graph";
/** A burst of commits saves once: the view in memory serves meanwhile. */
const SAVE_AFTER_MS = 5_000;

/** Worker side: the drawable graph — structure with settled positions — at
 * the snapshot's revision, serialized once. The feed page for the same
 * revision is published alongside, as live warming always did. */
export function buildGraphView(root: string): ProjectionView {
  recentSourcePage(root, 0, 1);
  return withVaultSnapshot(root, (_db, revision) => {
    const built = buildAssertionGraph(root, () => {}, vaultRecord(root));
    const graph = graphWithLayout(root, built.nodes.length ? built : { ...EMPTY_GRAPH, nodes: [], edges: [] });
    return { revision, hash: graph.hash, body: JSON.stringify(graph) };
  });
}

interface Held extends ProjectionView { graph?: Graph }
const held = new Map<string, Held | null>();
const builds = new Map<string, Promise<void>>();
const behind = new Set<string>();
const saves = new Map<string, ReturnType<typeof setTimeout>>();

function cancelSave(root: string): void {
  clearTimeout(saves.get(root));
  saves.delete(root);
}
function scheduleSave(root: string, view: ProjectionView): void {
  cancelSave(root);
  const timer = setTimeout(() => { saves.delete(root); saveProjectionView(root, NAME, view); }, SAVE_AFTER_MS);
  timer.unref?.();
  saves.set(root, timer);
}

/** The current view, from memory, else as saved last session. */
function current(root: string): Held | undefined {
  if (!held.has(root)) held.set(root, projectionView(root, NAME) ?? null);
  return held.get(root) ?? undefined;
}

/** The last view's graph without waiting: undefined before the first build.
 * Shared and parsed once per view — readers copy, never mutate. */
export function savedGraph(root: string): Graph | undefined {
  const view = current(root);
  if (!view) return undefined;
  return view.graph ??= JSON.parse(view.body) as Graph;
}

export type BuildGraphView = (root: string) => Promise<ProjectionView>;
const inWorker: BuildGraphView = (root) => background<ProjectionView>({ kind: "graph-view", root });

/** Bring the view up to the projection's revision. Resolves once it is. */
export function maintainGraphView(root: string, build: BuildGraphView = inWorker): Promise<void> {
  const running = builds.get(root);
  if (running) { behind.add(root); return running; }
  const run = (async () => {
    do {
      behind.delete(root);
      if (current(root)?.revision === readModelRevision(root)) continue;
      const view = await build(root);
      held.set(root, view);
      scheduleSave(root, view);
    } while (behind.has(root));
  })().finally(() => builds.delete(root));
  builds.set(root, run);
  return run;
}

/** The graph for a request: the last view at once, with a build started when
 * the projection has moved past it. Only a vault with no view yet waits. */
export async function currentGraph(root: string, build?: BuildGraphView): Promise<Graph> {
  const view = current(root);
  if (!view) await maintainGraphView(root, build);
  else if (view.revision !== readModelRevision(root)) void maintainGraphView(root, build).catch(() => {});
  return savedGraph(root) ?? EMPTY_GRAPH;
}

/** Save the current view now rather than after the burst settles. */
export function saveGraphView(root: string): void {
  cancelSave(root);
  const view = held.get(root);
  if (view) saveProjectionView(root, NAME, view);
}

/** Tests and a vault switch: forget what this process holds for `root`. */
export function forgetGraphView(root: string): void {
  held.delete(root);
  cancelSave(root);
}
