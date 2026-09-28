import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceThreads, threadsByInsertion } from "../lib/sourceThreads";
import { insertion, nativeVault } from "./support/vault";
import { appendSourceInsertionEvent, insertionEventRel, type SourceInsertion } from "../lib/insertionLog";
import { appendAssertionEvent, createAssertionEvent, assertionEntityId } from "../lib/assertionLog";
import { sourceThreadView, invalidateAssertionRecord } from "../lib/assertionEntityView";
import { recentSourcePage } from "../lib/sourceFeed";
import { notePayload, resolveLink } from "../lib/noteRead";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { findNode } from "../web/ui/src/lib/neighbourhood";

const email = (n: number, title = "Re: Archive acquisition discussion", envelope: Record<string, unknown> = {}): SourceInsertion => insertion({
  id: `ins_${n.toString(16).padStart(24, "0")}`, title,
  received_at: new Date(Date.UTC(2026, 8, 8, 10, n)).toISOString(),
  envelope: { source: "email", kind: "email", inbox: "me@example.com", ...envelope },
});

test("email threads prefer provider identity, with exact subject fallback and stable paths", () => {
  const a = email(1), b = email(2, "Fwd: RE: Archive  acquisition discussion");
  const [thread] = sourceThreads([a, b]);
  expect(thread!.members.map(s => s.id)).toEqual([b.id, a.id]);
  expect(thread!.title).toBe("Archive acquisition discussion");
  expect(sourceThreads([b, a, email(3)])[0]!.path).toBe(thread!.path);
  const gmail = (id: string) => ({ url: `https://mail.google.com/mail/u/0/#all/${id}` });
  const groups = sourceThreads([email(4, "Old subject", gmail("abc")), email(5, "Changed subject", gmail("abc")), email(6, "Old subject", gmail("def"))]);
  expect(groups.map(t => t.members.length).sort()).toEqual([1, 2]);
  expect(sourceThreads([a, email(7, a.title, { inbox: "another@example.com" })])).toHaveLength(2);
  expect(sourceThreads([email(8, "Hello"), email(9, "Hello"), email(10, "(no subject)")])).toHaveLength(0);
  expect(sourceThreads([email(11, a.title, { source: "web", kind: "article" })])).toHaveLength(0);
});

test("superseded arrivals are omitted without breaking a bookmarked singleton thread", () => {
  const a = email(1), b = email(2);
  b.source_id = a.source_id; b.envelope.supersedes = a.id;
  const threads = sourceThreads([a, b]);
  expect(threads[0]!.members).toEqual([b]);
  expect(threadsByInsertion(threads).size).toBe(0);
  expect(threads[0]!.path).toBe(sourceThreads([a])[0]!.path);
});

test("feed pages conversations, combined reader preserves all assertions and originals, graph draws one source", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-threads-"));
  const a = email(1), b = email(2), other = email(0, "A different conversation");
  for (const s of [a, b, other]) appendSourceInsertionEvent(root, s);
  const entity = { id: assertionEntityId("Archive"), label: "Archive" };
  const held = new Map([a, b, other].map(s => [s.id, s]));
  for (const [i, sources] of [[a.id], [b.id], [a.id, b.id]].entries()) appendAssertionEvent(root, createAssertionEvent({
    text: `[[${entity.id}|Archive]] claim ${i}.`, entities: [entity], sources,
    author: { kind: "model", id: "test", invocation_id: "thread-test" }, confidence: "direct",
    created_at: `2026-09-08T12:0${i}:00Z`, produced_by: { procedure: "test", version: "1" },
  }, held));
  const page = recentSourcePage(root, 0, 1), row = page.recent[0]!;
  expect(page.total).toBe(2); expect(page.nextOffset).toBe(1);
  expect(row.threadCount).toBe(2); expect(row.status).toBe("filed");
  expect(row.modified).toBe(Date.parse(b.received_at!));
  expect(recentSourcePage(root, 1, 1).recent[0]!.path).toBe(insertionEventRel(other));
  const view = sourceThreadView(root, row.path)!;
  expect(view.assertions).toHaveLength(3); // a claim citing both messages occurs once
  expect(view.assertions[2]!.sources).toHaveLength(2);
  const payload = notePayload(root, row.path);
  expect(payload.status).toBe(200);
  if (payload.status === 200) {
    expect(payload.note.markdown).toContain("claim 0"); expect(payload.note.markdown).toContain("claim 1");
    expect(payload.note.markdown).toContain(insertionEventRel(a)); expect(payload.note.markdown).toContain(insertionEventRel(b));
  }
  expect(resolveLink(root, row.path, new Map())).toBe(row.path);
  expect(notePayload(root, insertionEventRel(a)).status).toBe(200);
  const graph = buildAssertionGraph(root), node = graph.nodes.find(n => n.path === row.path)!;
  expect(node).toBeDefined(); expect(node.degree).toBe(1);
  expect(node.memberPaths).toHaveLength(2);
  expect(graph.edges.find(e => e.source === node.id || e.target === node.id)!.weight).toBe(3);
  expect(findNode(graph.nodes, insertionEventRel(a))).toBe(findNode(graph.nodes, row.path));
  const newer = email(3); appendSourceInsertionEvent(root, newer); invalidateAssertionRecord(root);
  expect(recentSourcePage(root, 0, 1).recent[0]).toMatchObject({ path: row.path, threadCount: 3, status: "pending" });
  expect(sourceThreadView(root, row.path)!.members).toHaveLength(3);
  expect(notePayload(root, `projection/threads/thread_${"f".repeat(24)}.md`).status).toBe(404);
  expect(notePayload(root, "projection/threads/../../.env").status).toBe(403);
});

test("distinctive subjects join provider-split conversations and preserve earlier links", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-thread-joins-"));
  const title = "Patti Smith archive: Metropolitan Review run + inscribed Seventh Heaven";
  const a = email(1, title, { url: "https://mail.google.com/mail/u/0/#all/abc" });
  const b = email(2, `Re: ${title}`, { url: "https://mail.google.com/mail/u/0/#all/def" });
  const c = email(3, "Changed subject", { url: "https://mail.google.com/mail/u/0/#all/def" });
  const oldPath = sourceThreads([c])[0]!.path;
  for (const s of [a, b, c]) appendSourceInsertionEvent(root, s);
  const [thread] = sourceThreads([a, b, c]);
  expect(thread!.members).toHaveLength(3);
  expect(thread!.aliases).toContain(oldPath);
  expect(sourceThreadView(root, oldPath)!.members).toHaveLength(3);
  expect(recentSourcePage(root, 0, 12).recent).toHaveLength(1);
});

test("the web thread door returns combined assertions and an original-message menu", () => {
  // The server binds its root at import time. Give this route test its own
  // process/vault so both insertion files and projected rows stay isolated.
  const root = nativeVault();
  try {
    const a = email(1001), b = email(1002);
    for (const row of [a, b]) appendSourceInsertionEvent(root, row);
    const path = sourceThreads([a, b])[0]!.path;
    const result = spawnSync(process.execPath, ["-e", `
      const { ROUTES } = await import(${JSON.stringify(new URL("../web/server.ts", import.meta.url).pathname)});
      const { dispatch } = await import(${JSON.stringify(new URL("../lib/httpx.ts", import.meta.url).pathname)});
      let status = 0;
      const handled = dispatch(ROUTES, { method: "GET", url: ${JSON.stringify(`/api/note?path=${path}`)} }, {
        writeHead: code => { status = code; },
        end: body => { console.log(JSON.stringify({ status, note: JSON.parse(body) })); },
      });
      if (!handled) process.exit(1);
    `], { env: { ...process.env, BIGBRAIN_VAULT: root }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const { status, note } = JSON.parse(result.stdout);
    expect(status).toBe(200);
    expect(note.sourceThread.messages).toHaveLength(2);
    expect(note.sourceAssertions).toEqual([]);
    expect(note.content).toContain("category: thread");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
