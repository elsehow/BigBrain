/** The graph as a view kept by its maintainer, not built per request
 * (docs/plans/2026-10-10-change-log.md, step 2).
 *
 * One build per vault at a time, in a worker, whenever the projection has
 * committed something the graph depends on since the view's revision; a build
 * that finishes behind the projection runs again. A journal write moves the
 * revision but not the graph: the view's revision advances without a build.
 * A reader is served the view only when it is current (R4,
 * docs/plans/2026-10-12-stages-and-views-refactor.md): the saved view is a
 * cache by revision, so a start serves the one saved last session when
 * nothing changed while the app was closed, and otherwise waits for the
 * build the projection's commit began. A read writes nothing: the
 * maintainer saves what it builds. The view is the graph view
 * (lib/views/graph.ts) over everything live. Its hash is its body's: the
 * stamp the viewer pushes and the ETag /api/graph answers with. Each build
 * also keeps what it drew each connection from (graph_evidence), the
 * briefing's evidence: a briefing reads the rows for its selection
 * (vaultReadModel.graphEvidence), never the record. */
import type { Graph } from "./graph";
import {
  lastChangeExcept, projectionView, saveGraphEvidence, saveProjectionView,
  type ChangeKind, type GraphEvidenceRow, type ProjectionView,
} from "./assertionProjection";
import type { ObserveConnection } from "./markdownGraph";
import { sha256hex } from "./hash";
import { EMPTY_GRAPH } from "./graphCache";
import { background } from "./readModelBackground";
import { recentSourcePage } from "./sourceFeed";
import { readModelRevision, vaultRecordOf, withSnapshot } from "./vaultReadModel";
import { fieldOf } from "./views/graph";
import { liveOf } from "./views/scope";

const NAME = "graph";
/** What the graph does not read. */
const IGNORES: readonly ChangeKind[] = ["journal", "fold_reject", "folds", "inclusion"];
/** A burst of commits saves once: the view in memory serves meanwhile. */
const SAVE_AFTER_MS = 5_000;

/** Each connection as the build draws it, by where it was written, in runs
 * of one assertion's or one document's. */
function evidenceRows(rows: GraphEvidenceRow[]): ObserveConnection {
  let pos = 0;
  return (a, b, evidence, at) => {
    const grp = at?.doc ?? evidence.assertion ?? "";
    pos = grp === rows.at(-1)?.grp ? pos + 1 : 0;
    rows.push({ grp, pos, a, b, assertion: evidence.assertion ?? "", path: evidence.path ?? "", link: at?.link ?? -1 });
  };
}

/** Worker side: the drawable graph — structure with settled positions — at
 * the snapshot's revision, serialized once, and its connections kept as the
 * briefing's evidence. The feed page for the same revision is published
 * alongside, as live warming always did. */
export function buildGraphView(root: string): ProjectionView {
  recentSourcePage(root, 0, 1);
  const rows: GraphEvidenceRow[] = [];
  const view = withSnapshot(root, (snapshot) => {
    const { revision } = snapshot;
    // seated as it stands at this revision (lib/views/layout.ts): no layout drawn before is read
    const record = vaultRecordOf(snapshot);
    const built = fieldOf(record, liveOf(record), evidenceRows(rows)); // no text: only where each came from
    const graph = built.nodes.length ? built : { ...EMPTY_GRAPH, nodes: [], edges: [] };
    const body = JSON.stringify(graph);
    return { revision, hash: sha256hex(body).slice(0, 16), body };
  });
  try { saveGraphEvidence(root, view.revision, rows); } catch { /* the next build keeps them */ }
  return view;
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
 * committed since. Advances its revision past commits it does not read, in
 * memory: the maintainer saves it. */
function holds(root: string, view: Held | undefined): boolean {
  if (!view) return false;
  if (view.revision === readModelRevision(root)) return true;
  const log = lastChangeExcept(root, IGNORES);
  const [generation, revision] = view.revision.split(":");
  const [lastGeneration, last] = log?.last.split(":") ?? [];
  if (!log || generation !== lastGeneration || Number(last) > Number(revision)) return false;
  held.set(root, { ...view, revision: log.at });
  return true;
}

/** A built view is the current one: saved after the burst, its stamp heard. */
function land(root: string, view: ProjectionView): void {
  const before = held.get(root)?.hash;
  held.set(root, view);
  scheduleSave(root, view);
  if (view.hash !== before) for (const listener of landed) listener(root);
}

/** Bring the view up to the projection's revision. Resolves once it is. */
export function maintainGraphView(root: string, build: BuildGraphView = inWorker): Promise<void> {
  const running = builds.get(root);
  if (running) { behind.add(root); return running; }
  const run = (async () => {
    do {
      behind.delete(root);
      const was = current(root)?.revision;
      if (holds(root, current(root))) { if (current(root)!.revision !== was) scheduleSave(root, current(root)!); continue; }
      land(root, await build(root));
    } while (behind.has(root));
  })().finally(() => builds.delete(root));
  builds.set(root, run);
  return run;
}

const EMPTY_VIEW: ProjectionView = (() => {
  const body = JSON.stringify(EMPTY_GRAPH);
  return { revision: "", hash: sha256hex(body).slice(0, 16), body };
})();

/** The view for a request, as served: the held one when it is current,
 * else the one the maintainer's build lands. */
export async function currentGraphView(root: string, build?: BuildGraphView): Promise<ProjectionView> {
  if (!holds(root, current(root))) await maintainGraphView(root, build);
  return current(root) ?? EMPTY_VIEW;
}

/** The same, parsed. */
export async function currentGraph(root: string, build?: BuildGraphView): Promise<Graph> {
  await currentGraphView(root, build);
  return savedGraph(root) ?? EMPTY_GRAPH;
}

/** The view at the projection's revision, for a reader that needs what is
 * committed now (a briefing, the memory pass's catalogue), with its revision. */
export async function freshGraph(root: string, build?: BuildGraphView): Promise<{ revision: string; graph: Graph }> {
  await maintainGraphView(root, build);
  return { revision: current(root)?.revision ?? "", graph: savedGraph(root) ?? EMPTY_GRAPH };
}

/** The same without waiting on a worker: the held view when it holds, else
 * built here, on this thread. For a caller with no maintainer to wait on (a
 * command, a test); the viewer awaits freshGraph first, so this finds it held. */
export function graphNow(root: string): Graph {
  if (!holds(root, current(root))) land(root, buildGraphView(root));
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
