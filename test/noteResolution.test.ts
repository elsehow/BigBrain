import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeVault, insertion } from "./support/vault";
import { resolveNote, readNoteFile } from "../lib/noteResolution";
import { jailMemoryNotePath, jailPath, notePayload } from "../lib/noteRead";
import { insertionEventRel } from "../lib/insertionLog";
import { sourceInsertionCached } from "../lib/assertionEntityView";
import { sourceThreads } from "../lib/sourceThreads";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const noMarkdown = () => undefined;
function fixture() {
  const sources = [1, 2].map(n => insertion({ id: `ins_${String(n).repeat(24)}`, source_id: `mail-${n}`,
    title: n === 1 ? "Archive acquisition discussion" : "Re: Archive acquisition discussion",
    envelope: { source: "email", kind: "email", inbox: "me@example.com" } }));
  const root = nativeVault({ insertions: sources, files: {
    "memory/topic.md": '---\ntitle: "Named topic"\n---\n# Heading\n\nEvidence.',
    "requests/private.md": "# Request\nPrivate to the viewer's allowed trees.",
  } });
  roots.push(root); return { root, sources };
}

test("source and thread identities agree with the reader while retaining their distinct content", () => {
  const { root, sources } = fixture();
  const path = insertionEventRel(sources[0]!);
  expect(resolveNote(root, path, { markdown: noMarkdown })).toMatchObject({
    kind: "source", id: `source:${sources[0]!.id}`, path, title: sources[0]!.title,
  });
  const thread = sourceThreads(sources)[0]!;
  const resolved = resolveNote(root, thread.path, { markdown: noMarkdown });
  expect(resolved).toMatchObject({ kind: "thread", id: thread.id, path: thread.path, title: thread.title });
  const payload = notePayload(root, thread.path);
  expect(payload.status === 200 && payload.note.title).toBe(resolved?.title);
});

test("Markdown interpretation is shared, while each caller authorizes its own served trees", () => {
  const { root } = fixture();
  const policy = { markdown: (path: string) => {
    const file = jailMemoryNotePath(root, path) ?? jailPath(root, path);
    return file ? readNoteFile(root, file) : undefined;
  } };
  const note = resolveNote(root, "memory/topic.md", policy);
  expect(note).toMatchObject({ kind: "markdown", title: "Named topic", markdown: { body: "# Heading\n\nEvidence." } });
  expect(notePayload(root, "memory/topic.md")).toMatchObject({ status: 200, note: { title: note?.title } });
  expect(resolveNote(root, "requests/private.md", policy)).toBeUndefined();
  expect(notePayload(root, "requests/private.md").status).toBe(403);
});

test("exact source readers and snapshot evidence keep their explicit failure policies", () => {
  const { root, sources } = fixture(), path = insertionEventRel(sources[0]!);
  const projected = { markdown: noMarkdown, source: sourceInsertionCached };
  const before = resolveNote(root, path, projected);
  writeFileSync(join(root, path), "broken JSON");
  expect(resolveNote(root, path, { markdown: noMarkdown })).toBeUndefined();
  expect(notePayload(root, path).status).toBe(404);
  expect(resolveNote(root, path, projected)).toEqual(before);
});
