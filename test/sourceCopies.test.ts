import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { assertionEntityPath } from "../lib/assertionEntityView";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { assertionEntityId, createAssertionEvent, type AssertionEntity } from "../lib/assertionLog";
import { appendAndProjectAssertion, appendAndProjectEntitySource, syncAssertionProjection } from "../lib/assertionProjection";
import { createEntitySourceEvent } from "../lib/entitySourceLog";
import { insertionEventRel, type SourceInsertion } from "../lib/insertionLog";
import { notePayload } from "../lib/noteRead";
import { copyKeys, sourceCopies } from "../lib/sourceCopies";
import { insertion, nativeVault } from "./support/vault";

const at = (url?: string, extra: Record<string, unknown> = {}) => ({ envelope: { kind: "web-clip", ...(url ? { url } : {}), ...extra } });
const file = (sha: string) => ({ attachments: [{ name: "paper.pdf", sha256: sha, bytes: 9, mime: "application/pdf" }] });
const SHA = "ab".repeat(32);

describe("copyKeys", () => {
  test("an arXiv paper is one paper whatever its address: abstract, PDF, version, or its DOI", () => {
    const key = "arxiv:2604.24698";
    for (const url of ["https://arxiv.org/abs/2604.24698", "https://arxiv.org/pdf/2604.24698v2", "http://www.arxiv.org/pdf/2604.24698v1.pdf", "https://doi.org/10.48550/arXiv.2604.24698"])
      expect(copyKeys(at(url))).toContain(key);
  });

  test("a DOI is the article on any publisher's address", () => {
    expect(copyKeys(at("https://dl.acm.org/doi/pdf/10.1145/3808267"))).toContain("doi:10.1145/3808267");
    expect(copyKeys(at("https://doi.org/10.1145/3808267"))).toContain("doi:10.1145/3808267");
    expect(copyKeys(at("https://example.org/2010.12345/notes"))).not.toContainEqual(expect.stringMatching(/^doi:/));
  });

  test("an address is itself without its tracking, fragment, trailing slash or www", () => {
    const plain = copyKeys(at("https://example.org/essays/lanterns?b=2&a=1"))[0];
    expect(plain).toBe("url:example.org/essays/lanterns?a=1&b=2");
    expect(copyKeys(at("https://www.example.org/essays/lanterns/?utm_source=x&a=1&b=2#part-2"))[0]).toBe(plain);
    expect(copyKeys(at("file:///Users/someone/lanterns.pdf"))).toEqual([]);
  });

  test("an original file is its sha256; talk and mail are never a work", () => {
    expect(copyKeys({ envelope: { kind: "pdf-import", ...file(SHA) } })).toEqual([`file:${SHA}`]);
    expect(copyKeys({ envelope: { kind: "meeting", url: "https://example.org/call" } })).toEqual([]);
    expect(copyKeys({ envelope: { kind: "note", source: "email", url: "https://example.org/x" } })).toEqual([]);
  });
});

describe("sourceCopies", () => {
  const src = (n: number, received: string, envelope: Record<string, unknown>) =>
    insertion({ id: `ins_${String(n).repeat(24)}`, received_at: received, envelope: { kind: "web-clip", ...envelope } });

  test("copies chain through any shared key; the text leads a newer stub; a lone source has none", () => {
    const text = src(1, "2026-10-01T00:00:00Z", { kind: "pdf-import", url: "https://arxiv.org/pdf/2604.24698", ...file(SHA) });
    const stub = src(2, "2026-10-02T00:00:00Z", { kind: "pdf-import", ...file(SHA) });
    const page = src(3, "2026-10-03T00:00:00Z", { url: "https://arxiv.org/abs/2604.24698v3" });
    const lone = src(4, "2026-10-04T00:00:00Z", { url: "https://example.org/other" });
    const asked: string[] = [];
    const copies = sourceCopies([text, stub, page, lone], { stub: (s) => { asked.push(s.id); return s.id === stub.id; } });
    expect(copies.get(stub.id)?.members.map((m) => m.id)).toEqual([page.id, text.id, stub.id]);
    expect(copies.get(text.id)).toBe(copies.get(stub.id)!);
    expect(copies.has(lone.id)).toBe(false);
    expect(asked.sort()).toEqual([text.id, stub.id, page.id].sort());
  });

  test("a caller's join makes copies of sources that share nothing else", () => {
    const a = src(5, "2026-10-01T00:00:00Z", { url: "https://example.org/essay" });
    const b = src(6, "2026-10-02T00:00:00Z", { url: "https://archive.example/snapshot/essay" });
    const joins = new Map([[a.id, ["entity:ent_x"]], [b.id, ["entity:ent_x"]]]);
    expect(sourceCopies([a, b], { joins, stub: () => false }).get(a.id)?.members.map((m) => m.id)).toEqual([b.id, a.id]);
  });
});

describe("copies in the vault", () => {
  const PAPER = "Tidal Lanterns in Coastal Navigation: A Field Survey";
  const ent: AssertionEntity = { id: assertionEntityId(PAPER), label: PAPER };
  const AUTHOR = { kind: "user" as const, id: "owner@example.com" };
  const PRODUCED = { procedure: "test", version: "1" };
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  // the same PDF captured twice: its text first, then a stub of its bytes
  const text = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "capture-a", title: PAPER, received_at: "2026-10-01T00:00:00.000Z",
    body: `## Text layer\n\n${"We surveyed lantern use across forty harbours. ".repeat(12)}`,
    envelope: { kind: "pdf-import", url: "https://example.org/papers/lanterns.pdf", ...file(SHA) } });
  const stub = insertion({ id: `ins_${"c".repeat(24)}`, source_id: "capture-c", title: `${PAPER}.pdf`, received_at: "2026-10-02T00:00:00.000Z",
    body: `Captured; text not extracted.\n\n[paper.pdf](blob:${SHA})`, envelope: { kind: "pdf-import", ...file(SHA) } });

  const vault = (): string => {
    const root = nativeVault({ prefix: "bb-copies-", insertions: [text, stub] });
    roots.push(root);
    syncAssertionProjection(root);
    const claim = (source: SourceInsertion, t: string) => appendAndProjectAssertion(root, createAssertionEvent({
      text: `[[${ent.id}|${PAPER}]] surveyed forty harbours.`, entities: [ent], sources: [source.id],
      author: { kind: "model", id: "test-model", invocation_id: "run-1" }, confidence: "direct", created_at: t, produced_by: PRODUCED,
    }, new Map([[source.id, source]])));
    claim(stub, "2026-10-02T00:01:00.000Z");
    claim(text, "2026-10-02T00:02:00.000Z");
    // bound to the stub alone: the copy it shares a file with joins it all the same
    appendAndProjectEntitySource(root, createEntitySourceEvent({
      entity: ent, insertion_id: stub.id, bound: true, author: AUTHOR, created_at: "2026-10-02T00:03:00.000Z", produced_by: PRODUCED,
    }));
    return root;
  };
  const read = (root: string, path: string) => {
    const p = notePayload(root, path);
    if (p.status !== 200) throw new Error(p.error);
    return p.note.markdown;
  };

  test("the graph draws one node, the text's, carrying the stub's path; the entity opens it", () => {
    const graph = buildAssertionGraph(vault());
    const sources = graph.nodes.filter((n) => n.group === "source");
    expect(sources.map((n) => [n.id, n.memberPaths])).toEqual([[`source:${text.id}`, [insertionEventRel(stub)]]]);
    expect(graph.nodes.find((n) => n.id === ent.id)?.opens).toEqual([`source:${text.id}`]);
  });

  test("the entity's dossier names every copy, the text first; each copy names the other", () => {
    const root = vault();
    expect(read(root, assertionEntityPath(ent.id))).toContain(
      `_The document itself, in the vault: [[${insertionEventRel(text)}|${PAPER}]] · [[${insertionEventRel(stub)}|${PAPER}.pdf]].`);
    expect(read(root, insertionEventRel(stub))).toContain(`_Also in the vault as: [[${insertionEventRel(text)}|${PAPER}]], the fullest first._`);
    expect(read(root, insertionEventRel(text))).toContain(`_Also in the vault as: [[${insertionEventRel(stub)}|${PAPER}.pdf]], the fullest first._`);
  });
});
