import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mdVault, insertion } from "./support/vault";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { projectNotes, projectSourceInsertion, recoverAssertionProjection } from "../lib/assertionProjection";
import { assertionGraphEvidenceCached, assertionGraphEvidenceAsync, invalidateGraphCaches } from "../lib/graphCache";
import { withVaultSnapshot } from "../lib/vaultReadModel";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { invalidateGraphCaches(root); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mdVault(); roots.push(root);
  const first = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "a" });
  const second = insertion({ id: `ins_${"b".repeat(24)}`, source_id: "b" });
  appendSourceInsertionEvent(root, first);
  return { root, first, second };
}

for (const [mode, read] of [["sync", assertionGraphEvidenceCached], ["async", assertionGraphEvidenceAsync]] as const) {
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
    expect(appended.graph.nodes.some(n => n.id === `source:${second.id}`)).toBe(true);
    expect(appended.revision).not.toBe(initial.revision);

    // A file put in log/ by hand is not projected; no read takes the census.
    writeFileSync(join(root, insertionEventRel(third)), JSON.stringify(third));
    expect(await read(root)).toBe(appended);
    recoverAssertionProjection(root);
    const healed = await read(root);
    expect(healed.graph.nodes.some(n => n.id === `source:${third.id}`)).toBe(true);

    // A note edit is likewise invisible to a read until its door projects it.
    writeFileSync(join(root, path), `# After\n\n[[${insertionEventRel(second)}]]`);
    expect(await read(root)).toBe(healed);
    projectNotes(root, [path]);
    const edited = await read(root);
    expect(edited.graph.nodes.find(n => n.path === path)?.title).toBe("After");
    expect(edited.connections.some(c => [c.from, c.to].includes(`source:${second.id}`))).toBe(true);

    // Retraction by hand (deleting the file) is likewise recovery's to find.
    rmSync(join(root, insertionEventRel(second)));
    expect(await read(root)).toBe(edited);
    recoverAssertionProjection(root);
    const removed = await read(root);
    expect(removed.graph.nodes.some(n => n.id === `source:${second.id}`)).toBe(false);
    expect(removed.connections.some(c => [c.from, c.to].includes(`source:${second.id}`))).toBe(false);
    expect(await read(root)).toBe(removed); // An unchanged projection reuses the graph.
  });
}

test("an async graph reader borrows an active snapshot before yielding", async () => {
  const { root, second } = fixture();
  const pending = withVaultSnapshot(root, (_db, revision) => {
    appendSourceInsertionEvent(root, second);
    projectSourceInsertion(root, second);
    return { revision, graph: assertionGraphEvidenceAsync(root) };
  });
  const borrowed = await pending.graph;
  expect(borrowed.revision).toBe(pending.revision);
  expect(borrowed.graph.nodes).toHaveLength(1);
  const latest = await assertionGraphEvidenceAsync(root);
  expect(latest.graph.nodes).toHaveLength(2);
  expect(latest.revision).not.toBe(borrowed.revision);
});
