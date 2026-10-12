import { sourceThreads } from "../lib/sourceThreads";
import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mdVault, insertion } from "./support/vault";
import { appendAssertionEvent, createAssertionEvent, assertionEntityId } from "../lib/assertionLog";
import { assertionEntityView, assertionEntityPath } from "../lib/assertionEntityView";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { projectSourceInsertion, rebuildAssertionProjection, openAssertionProjectionReadonly, projectionRevision, recoverAssertionProjection, syncAssertionProjection } from "../lib/assertionProjection";
import { documentLinkTexts, sourceCatalog, sourceReadTargets, threadReadModel, invalidateVaultReadModel, publishReadModel, vaultRecord, withVaultSnapshot, projectedSource, projectedMarkdown, sourceRecord } from "../lib/vaultReadModel";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { recentSourcePage } from "../lib/sourceFeed";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mdVault(); roots.push(root);
  const source = insertion({ id: `ins_${"1".repeat(24)}`, title: "First source" });
  appendSourceInsertionEvent(root, source);
  return { root, source };
}

test("a feed-only miss decodes no assertion text, Markdown metadata, or link evidence", () => {
  const { root, source } = fixture();
  const entity = { id: assertionEntityId("Example"), label: "Example" };
  appendAssertionEvent(root, createAssertionEvent({ text: `[[${entity.id}|Example]] has assertion-only-prose.`,
    entities: [entity], sources: [source.id], author: { kind: "agent", id: "test" }, confidence: "direct",
    created_at: "2026-09-20T00:00:00Z", produced_by: { procedure: "test", version: "1" } }, new Map([[source.id, source]])));
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "memory/topic.md"), `# Markdown-only-heading\n\nEvidence-only-text [[${insertionEventRel(source)}]]`);
  withVaultSnapshot(root, () => {}); // Pay projection work before observing reads.
  const parse = JSON.parse, texts: string[] = [];
  const spy = spyOn(JSON, "parse").mockImplementation((text, reviver) => { texts.push(text); return parse(text, reviver); });
  try { expect(recentSourcePage(root, 0, 10).recent[0]!.status).toBe("filed"); }
  finally { spy.mockRestore(); }
  const parsed = texts.join("\n");
  expect(parsed).not.toContain("assertion-only-prose");
  expect(parsed).not.toContain("Markdown-only-heading");
  expect(parsed).not.toContain("Evidence-only-text");
  const feed = sourceRecord(root), graph = vaultRecord(root);
  expect(graph.sources).toBe(feed.sources);
  expect(graph.threadByInsertion).toBe(feed.threadByInsertion);
  expect(graph.cited).toBe(feed.cited);
  expect(graph.documents).toHaveLength(1);
});

test("graph/feed records retain compact evidence while selected note reads retain full bodies", () => {
  const root = mdVault(); roots.push(root);
  mkdirSync(join(root, "memory"));
  const path = "memory/topic.md", markdown = "# Topic\n\n" + "Long memory content. ".repeat(2000);
  writeFileSync(join(root, path), markdown);
  const evidence = "Unicode café 🙂 before [Topic](memory/topic.md) and after.";
  const body = "Long source content. ".repeat(2000) + "\n\n" + evidence + "\n\n```md\n[hidden](ignored.md)\n```";
  const source = insertion({ id: `ins_${"a".repeat(24)}`, body });
  appendSourceInsertionEvent(root, source);
  const verify = () => {
    const record = vaultRecord(root);
    const summary = record.sources.get(source.id)!;
    expect(summary).not.toHaveProperty("body");
    expect(summary.excerpt).toHaveLength(240);
    expect(record.documents).toEqual([{ id: path, path, title: "Topic" }]);
    // the record names the link; its paragraph is evidence, read apart
    expect(record.documentLinks.get(`source:${source.id}`)!.links).toEqual([{ target: path, markdown: true }]);
    expect(documentLinkTexts(root).get(`source:${source.id}`)).toEqual([evidence]);
    expect(projectedSource(root, source.id)!.body).toBe(body);
    expect(projectedMarkdown(root, path)).toBe(markdown);
    expect(recentSourcePage(root, 0, 1).recent[0]!.excerpt).toBe(summary.excerpt);
    return buildAssertionGraph(root);
  };
  const graph = verify();
  rebuildAssertionProjection(root);
  expect(verify()).toEqual(graph);
});

test("Markdown edits and deletion atomically advance the record and its extracted links", () => {
  const { root, source } = fixture();
  mkdirSync(join(root, "memory"));
  const path = join(root, "memory/topic.md");
  writeFileSync(path, `# Topic\n\n[[${insertionEventRel(source)}]]`);
  const first = buildAssertionGraph(root);
  expect(first.edges).toHaveLength(1);
  const revision = projectionRevision(root);
  writeFileSync(path, "# Topic\n\nNo links.");
  expect(buildAssertionGraph(root).edges).toHaveLength(0);
  expect(projectionRevision(root)).not.toBe(revision);
  rmSync(path);
  expect(buildAssertionGraph(root).nodes.some(n => n.id === "memory/topic.md")).toBe(false);
  withVaultSnapshot(root, db => {
    expect(db.query("SELECT count(*) AS n FROM document_links WHERE path LIKE 'markdown:%'").get()).toEqual({ n: 0 });
  });
});

test("stale derived results cannot overwrite a newer feed revision", () => {
  const { root } = fixture();
  const first = vaultRecord(root);
  expect(recentSourcePage(root, 0, 1).total).toBe(1);
  const second = insertion({ id: `ins_${"2".repeat(24)}`, source_id: "second", title: "Second", received_at: "2026-09-20T00:00:00Z" });
  appendSourceInsertionEvent(root, second); projectSourceInsertion(root, second);
  expect(recentSourcePage(root, 0, 1).recent[0]!.title).toBe("Second");
  expect(publishReadModel(root, first.revision, db => db.run("DELETE FROM read_feed"))).toBe(false);
  expect(recentSourcePage(root, 1, 1)).toMatchObject({ total: 2, nextOffset: null, recent: [{ title: "First source" }] });
});

test("retracting/restoring a source updates openable views while preserving its assertions", () => {
  const { root, source } = fixture();
  const entity = { id: assertionEntityId("Example"), label: "Example" };
  appendAssertionEvent(root, createAssertionEvent({ text: `[[${entity.id}|Example]] exists.`, entities: [entity], sources: [source.id],
    author: { kind: "agent", id: "test" }, confidence: "direct", created_at: "2026-09-20T00:00:00Z",
    produced_by: { procedure: "test", version: "1" } }, new Map([[source.id, source]])));
  expect(recentSourcePage(root, 0, 10).total).toBe(1);
  const revision = projectionRevision(root);
  rmSync(join(root, insertionEventRel(source)));
  // A hand retraction is the census's to find: reads alone do not scan log/.
  expect(recentSourcePage(root, 0, 10).total).toBe(1);
  recoverAssertionProjection(root);
  invalidateVaultReadModel(root);
  expect(recentSourcePage(root, 0, 10).total).toBe(0);
  expect(buildAssertionGraph(root).nodes).toHaveLength(0);
  expect(projectionRevision(root)).not.toBe(revision);
  expect(assertionEntityView(root, assertionEntityPath(entity.id))?.assertions).toHaveLength(1);
  expect(assertionEntityView(root, assertionEntityPath(entity.id))?.assertions[0]!.sources).toEqual([]);
  appendSourceInsertionEvent(root, source); recoverAssertionProjection(root);
  expect(recentSourcePage(root, 0, 10).total).toBe(1);
  expect(buildAssertionGraph(root).nodes).toHaveLength(2);
});

test("failed catch-up keeps Markdown and the feed at the last complete revision", () => {
  const { root } = fixture();
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "memory/topic.md"), "# Before");
  recentSourcePage(root, 0, 10);
  const revision = projectionRevision(root);
  writeFileSync(join(root, "memory/topic.md"), "# After");
  mkdirSync(join(root, "log/assertions/2026-09"), { recursive: true });
  const broken = join(root, "log/assertions/2026-09/ast_broken.json");
  writeFileSync(broken, "{}");
  // A hand-written log file is only seen by recovery, which must fail whole.
  expect(() => recoverAssertionProjection(root)).toThrow();
  const db = openAssertionProjectionReadonly(root);
  try {
    expect(projectionRevision(root, db)).toBe(revision);
    expect(JSON.parse((db.query("SELECT document_json FROM markdown_bodies").get() as { document_json: string }).document_json).title).toBe("Before");
    expect(db.query("SELECT count(*) AS n FROM read_feed").get()).toEqual({ n: 1 });
  } finally { db.close(); }
  rmSync(broken);
  syncAssertionProjection(root);
  expect(vaultRecord(root).documents[0]!.title).toBe("After");
});

test("published source links remain usable without reparsing immutable event files", () => {
  const { root, source } = fixture();
  const graph = buildAssertionGraph(root);
  writeFileSync(join(root, insertionEventRel(source)), "damaged after projection");
  // Incremental projection's established contract retains the validated copy.
  expect(buildAssertionGraph(root)).toEqual(graph);
  expect(recentSourcePage(root, 0, 1).recent[0]!.title).toBe(source.title);
});


test("nested note and graph reads retain their snapshot across a concurrent publication", () => {
  const { root } = fixture();
  withVaultSnapshot(root, (_db, revision) => {
    const sources = sourceRecord(root);
    expect(vaultRecord(root).sources.size).toBe(1);
    const second = insertion({ id: `ins_${"2".repeat(24)}`, source_id: "second" });
    appendSourceInsertionEvent(root, second); projectSourceInsertion(root, second);
    expect(projectionRevision(root)).not.toBe(revision);
    expect(vaultRecord(root).revision).toBe(revision);
    expect(sourceRecord(root)).toBe(sources);
    expect(buildAssertionGraph(root).nodes).toHaveLength(1);
  });
  expect(vaultRecord(root).sources.size).toBe(2);
});

test("thread membership and metadata stay at the borrowed revision across appends and rebuilds", () => {
  const { root, source } = fixture();
  const a = { ...source, id: `ins_${"a".repeat(24)}`, source_id: "email-a", title: "Long distinctive planning conversation for September", envelope: { kind: "email", inbox: "a@example.com" } };
  const b = { ...a, id: `ins_${"b".repeat(24)}`, source_id: "email-b" };
  appendSourceInsertionEvent(root, a);
  const path = sourceThreads([a])[0]!.path;
  withVaultSnapshot(root, () => {
    expect(sourceCatalog(root).threads[0]!.members).toHaveLength(1);
    appendSourceInsertionEvent(root, b); projectSourceInsertion(root, b);
    expect(sourceCatalog(root).threads[0]!.members).toHaveLength(1);
    expect(threadReadModel(root, path)!.members).toHaveLength(1);
  });
  expect(threadReadModel(root, path)!.members).toHaveLength(2);
  const view = threadReadModel(root, path);
  const targets = sourceReadTargets(root, [path, insertionEventRel(a), "../" + insertionEventRel(a)]);
  expect(targets.size).toBe(2);
  expect(targets.get(path)).toHaveLength(2);
  expect(targets.get(path)!.every(s => !("body" in s))).toBe(true);
  withVaultSnapshot(root, () => {
    rebuildAssertionProjection(root);
    expect(threadReadModel(root, path)).toEqual(view);
  });
  expect(threadReadModel(root, path)).toEqual(view);
  rmSync(join(root, insertionEventRel(b))); recoverAssertionProjection(root); invalidateVaultReadModel(root);
  expect(sourceCatalog(root).threads[0]!.members.map(s => s.id)).toEqual([a.id]);
  expect(threadReadModel(root, a.id, true)).toBeUndefined();
});
