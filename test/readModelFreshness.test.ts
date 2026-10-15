import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mdVault, insertion } from "./support/vault";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { assertionDbPath, projectionView, projectNotes, projectSourceInsertion, recoverAssertionProjection } from "../lib/assertionProjection";
import { forgetGraphView, freshGraph, GRAPH_VIEW, graphNow, saveGraphView } from "../lib/maintainedGraph";
import { graphEvidence } from "../lib/vaultReadModel";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { forgetGraphView(root); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mdVault(); roots.push(root);
  const first = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "a" });
  const second = insertion({ id: `ins_${"b".repeat(24)}`, source_id: "b" });
  appendSourceInsertionEvent(root, first);
  return { root, first, second };
}

const touches = (root: string, id: string) => graphEvidence(root, [id]).length > 0;
for (const [mode, read] of [["sync", graphNow], ["async", async (root: string) => (await freshGraph(root)).graph]] as const) {
  test(`${mode} graph-only reads see engine writes at once, note edits through their door, hand-made log changes after recovery`, async () => {
    const { root, first, second } = fixture();
    const third = insertion({ id: `ins_${"c".repeat(24)}`, source_id: "c" });
    const path = "memory/topic.md";
    mkdirSync(join(root, "memory"));
    writeFileSync(join(root, path), `# Before\n\n[[${insertionEventRel(first)}]]`);
    const initial = await read(root);
    // An engine write projects itself, as another process's landing does:
    // no notification, watcher or clock — the next read's revision says so.
    appendSourceInsertionEvent(root, second);
    projectSourceInsertion(root, second);
    const appended = await read(root);
    expect(appended.nodes.some(n => n.id === `source:${second.id}`)).toBe(true);
    expect(appended).not.toBe(initial);

    // A file put in log/ by hand is not projected; no read takes the census.
    writeFileSync(join(root, insertionEventRel(third)), JSON.stringify(third));
    expect(await read(root)).toBe(appended);
    recoverAssertionProjection(root);
    const healed = await read(root);
    expect(healed.nodes.some(n => n.id === `source:${third.id}`)).toBe(true);

    // A note edit is likewise invisible to a read until its door projects it.
    writeFileSync(join(root, path), `# After\n\n[[${insertionEventRel(second)}]]`);
    expect(await read(root)).toBe(healed);
    projectNotes(root, [path]);
    const edited = await read(root);
    expect(edited.nodes.find(n => n.path === path)?.title).toBe("After");
    expect(touches(root, `source:${second.id}`)).toBe(true);

    // Retraction by hand (deleting the file) is likewise recovery's to find.
    rmSync(join(root, insertionEventRel(second)));
    expect(await read(root)).toBe(edited);
    recoverAssertionProjection(root);
    const removed = await read(root);
    expect(removed.nodes.some(n => n.id === `source:${second.id}`)).toBe(false);
    expect(touches(root, `source:${second.id}`)).toBe(false);
    expect(await read(root)).toBe(removed); // An unchanged projection reuses the graph.
  });
}

test("a view another engine build saved is never served, and this build's save drops it", () => {
  const { root } = fixture();
  const built = graphNow(root);
  saveGraphView(root);
  forgetGraphView(root);
  // what an older engine saved at the same revision: the legacy name, and another build's
  const ours = projectionView(root, GRAPH_VIEW)!;
  const db = new Database(assertionDbPath(root));
  for (const name of ["graph", "graph@0123456789ab"])
    db.query("INSERT INTO views(name, revision, hash, body) VALUES (?, ?, ?, ?)").run(name, ours.revision, "stale", JSON.stringify({ ...built, nodes: [] }));
  db.query("DELETE FROM views WHERE name = ?").run(GRAPH_VIEW);
  db.close();
  expect(graphNow(root).nodes).toEqual(built.nodes);
  saveGraphView(root);
  expect(projectionView(root, "graph")).toBeUndefined();
  expect(projectionView(root, "graph@0123456789ab")).toBeUndefined();
  expect(projectionView(root, GRAPH_VIEW)?.hash).toBe(ours.hash);
});
