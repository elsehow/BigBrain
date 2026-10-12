/** The graph as a view kept by its maintainer, not built per request
 * (docs/plans/2026-10-10-change-log.md, step 2).
 *
 * One build per vault at a time, in a worker, whenever the projection has
 * committed something the graph depends on since the view's revision; a build
 * that finishes behind the projection runs again. A journal write moves the
 * revision but not the graph: the view's revision advances without a build.
 * Readers get the last view at once — a request is a lookup — and a start
 * serves the view saved last session when nothing changed while the app was
 * closed. The view's hash is its body's: the stamp the viewer pushes and the
 * ETag /api/graph answers with. Briefing evidence is not part of the view;
 * its readers still prepare it (graphCache.assertionGraphEvidenceAsync). */
import type { Graph } from "./graph";
import { buildAssertionGraph } from "./assertionGraph";
import { lastChangeExcept, projectionView, saveProjectionView, type ChangeKind, type ProjectionView } from "./assertionProjection";
import { sha256hex } from "./hash";
import { EMPTY_GRAPH, graphWithLayout } from "./graphCache";
import { background } from "./readModelBackground";
import { recentSourcePage } from "./sourceFeed";
import { readModelRevision, vaultRecord, withVaultSnapshot } from "./vaultReadModel";

const NAME = "graph";
/** What the graph does not read. */
const IGNORES: readonly ChangeKind[] = ["journal"];
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
    const body = JSON.stringify(graph);
    return { revision, hash: sha256hex(body).slice(0, 16), body };
  });
}

interface Held extends ProjectionView { graph?: Graph }
const held = new Map<string, Held | null>();
const builds = new Map<string, Promise<void>>();
const behind = new Set<string>();
const saves = new Map<string, ReturnType<typeof setTimeout>>();
const landed = new Set<(root: string) => void>();

/** Hear each new view as it lands: the viewer pushes its stamp. */
export function onGraphView(listener: (root: string) => void): () => void {
  landed.add(listener);
  return () => { landed.delete(listener); };
}

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

/** Whether `view` still reflects the projection: nothing it reads has been
 * committed since. Advances its revision past commits it does not read. */
function holds(root: string, view: Held | undefined): boolean {
  if (!view) return false;
  if (view.revision === readModelRevision(root)) return true;
  const log = lastChangeExcept(root, IGNORES);
  const [generation, revision] = view.revision.split(":");
  const [lastGeneration, last] = log?.last.split(":") ?? [];
  if (!log || generation !== lastGeneration || Number(last) > Number(revision)) return false;
  const advanced = { ...view, revision: log.at };
  held.set(root, advanced);
  scheduleSave(root, advanced);
  return true;
}

/** Bring the view up to the projection's revision. Resolves once it is. */
export function maintainGraphView(root: string, build: BuildGraphView = inWorker): Promise<void> {
  const running = builds.get(root);
  if (running) { behind.add(root); return running; }
  const run = (async () => {
    do {
      behind.delete(root);
      if (holds(root, current(root))) continue;
      const view = await build(root);
      const before = held.get(root)?.hash;
      held.set(root, view);
      scheduleSave(root, view);
      if (view.hash !== before) for (const listener of landed) listener(root);
    } while (behind.has(root));
  })().finally(() => builds.delete(root));
  builds.set(root, run);
  return run;
}

const EMPTY_VIEW: ProjectionView = (() => {
  const body = JSON.stringify(EMPTY_GRAPH);
  return { revision: "", hash: sha256hex(body).slice(0, 16), body };
})();

/** The view for a request, as served: the last one at once, with a build
 * started when the projection has moved past it. Only a vault with no view
 * yet waits. */
export async function currentGraphView(root: string, build?: BuildGraphView): Promise<ProjectionView> {
  const view = current(root);
  if (!view) await maintainGraphView(root, build);
  else if (view.revision !== readModelRevision(root)) void maintainGraphView(root, build).catch(() => {});
  return current(root) ?? EMPTY_VIEW;
}

/** The same, parsed. */
export async function currentGraph(root: string, build?: BuildGraphView): Promise<Graph> {
  await currentGraphView(root, build);
  return savedGraph(root) ?? EMPTY_GRAPH;
}

/** The stamp of the view a request is served: empty before the first one. */
export function graphStamp(root: string): string {
  return current(root)?.hash ?? "";
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
