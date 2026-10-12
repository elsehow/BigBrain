import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { assertionEntityMarkdown, assertionEntityPath, assertionEntityView, projectedEntityMarkdown, truncatedEntityView } from "../lib/assertionEntityView";
import { assertionEntityId, createAssertionEvent, appendAssertionEvent } from "../lib/assertionLog";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { appendAndProjectAssertion, appendAndProjectDecline, projectSourceInsertion } from "../lib/assertionProjection";
import { createDeclineEvent } from "../lib/declineLog";
import { insertion } from "./support/vault";

const source = (id: string, title: string): SourceInsertion =>
  insertion({
    id,
    source_id: `ref-${id}`,
    title,
    body: "Ada and Ben discussed sparse probes for Atlas.",
    envelope: {},
    imported_path: `references/${id}.md`,
  });

describe("assertion graph", () => {
  test("projects only cited sources and explicitly linked entities", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-graph-"));
    const cited = source("ins-cited", "Research meeting");
    const untouched = source("ins-untouched", "Unrelated drop");
    appendSourceInsertionEvent(root, cited);
    appendSourceInsertionEvent(root, untouched);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    const atlas = { id: assertionEntityId("Atlas"), label: "Atlas" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `[[${ada.id}|Ada]] discussed sparse probes for [[${atlas.id}|Atlas]].`,
      entities: [ada, atlas],
      citations: [{ insertion_id: cited.id, quotes: [cited.body] }],
      author: { kind: "model", id: "test-model", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-18T12:00:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[cited.id, cited]])));

    const graph = buildAssertionGraph(root);
    expect(graph.projection).toBe("assertions");
    // the untouched drop is on the picture too — as a point still waiting
    // for the gardener (pending), edgeless, not as a cited source
    expect(graph.nodes.map((node) => [node.title, node.group, node.pending ?? false])).toEqual([
      ["Ada Lovelace", "entity", false],
      ["Atlas", "entity", false],
      ["Research meeting", "source", false],
      ["Unrelated drop", "source", true],
    ]);
    expect(graph.nodes.find((node) => node.group === "source")?.path)
      .toBe("log/insertions/undated/ins-cited.json");
    expect(graph.nodes.find((node) => node.title === "Ada Lovelace")?.path)
      .toBe(assertionEntityPath(ada.id));
    expect(graph.edges).toHaveLength(3);
    expect(graph.nodes.find((node) => node.title === "Unrelated drop")?.degree).toBe(0);

    const note = assertionEntityMarkdown(root, assertionEntityPath(ada.id));
    expect(note).toContain("type: entity");
    expect(note).toContain('title: "Ada Lovelace"');
    expect(note).toContain(`Ada discussed sparse probes for [[${assertionEntityPath(atlas.id)}|Atlas]].`);
    expect(note).toContain("[[log/insertions/undated/ins-cited.json|Research meeting]]");
    const view = assertionEntityView(root, assertionEntityPath(ada.id));
    expect(view?.id).toBe(ada.id);
    expect(view?.label).toBe("Ada Lovelace");
    expect(view?.assertions[0]?.text)
      .toBe(`Ada discussed sparse probes for [[${assertionEntityPath(atlas.id)}|Atlas]].`);
    expect(view?.assertions[0]?.confidence).toBe("direct");
    expect(view?.assertions[0]?.sources).toEqual([{
      insertion_id: "ins-cited",
      source_id: "ref-ins-cited",
      title: "Research meeting",
      path: "log/insertions/undated/ins-cited.json",
      band: "service",
      from: "test",
      via: "other", // a route outside the connector families wears the grouped chip (#433)
    }]);
  });

  test("voice arrivals remain visible and link to the assertions they support", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-graph-voice-"));
    const clip = source("ins-clip", "Semafor: Warsh at Jackson Hole");
    const directive: SourceInsertion = {
      ...source("ins-directive", "all eyes on warsh"),
      body: "all eyes on warsh",
      envelope: { kind: "directive", from_kind: "person", about: [clip.source_id] },
    };
    appendSourceInsertionEvent(root, clip);
    appendSourceInsertionEvent(root, directive);
    const warsh = { id: assertionEntityId("Kevin Warsh"), label: "Kevin Warsh" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `Nick flagged the Semafor piece on [[${warsh.id}|Kevin Warsh]] with "all eyes on warsh".`,
      entities: [warsh],
      citations: [
        { insertion_id: directive.id, quotes: [directive.body] },
        { insertion_id: clip.id, quotes: [clip.body] },
      ],
      author: { kind: "model", id: "test-model", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-27T21:00:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[clip.id, clip], [directive.id, directive]])));

    const graph = buildAssertionGraph(root);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([warsh.id, `source:${clip.id}`, `source:${directive.id}`].sort());
    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.find(n => n.id === warsh.id)?.degree).toBe(2);
  });

  test("an arrival the gardener has not reached draws as a pending point, until a citation or a decline settles it", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-graph-pending-"));
    const drop: SourceInsertion = { ...source("ins_dddddddddddddddddddddddd", "A dropped paper"), envelope: { kind: "pdf-import", source: "web-drop" } };
    appendSourceInsertionEvent(root, drop);
    // the vault's first drop, before any assertion exists: one point, turning
    let graph = buildAssertionGraph(root);
    expect(graph.nodes).toEqual([expect.objectContaining({
      id: `source:${drop.id}`, title: "A dropped paper", group: "source", degree: 0, pending: true,
      path: `log/insertions/undated/${drop.id}.json`,
    })]);
    expect(graph.edges).toEqual([]);
    const landed = graph.hash;
    expect(landed).not.toBe("assertions-empty");

    // a voice arrival stays visible too; a
    // superseded landing is its successor's
    const directive: SourceInsertion = { ...source("ins_eeeeeeeeeeeeeeeeeeeeeeee", "read this closely"), envelope: { kind: "directive", from_kind: "person", about: [drop.source_id] } };
    const older: SourceInsertion = { ...source("ins_f0f0f0f0f0f0f0f0f0f0f0f0", "An older landing"), source_id: "ref-same" };
    const newer: SourceInsertion = { ...source("ins_f1f1f1f1f1f1f1f1f1f1f1f1", "The same, re-landed"), source_id: "ref-same", envelope: { supersedes: older.id } };
    for (const event of [directive, older, newer]) { appendSourceInsertionEvent(root, event); projectSourceInsertion(root, event); }
    graph = buildAssertionGraph(root);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([`source:${drop.id}`, `source:${newer.id}`, `source:${directive.id}`].sort());
    expect(graph.nodes.every((n) => n.pending && n.degree === 0)).toBe(true);
    expect(graph.edges).toEqual([]);
    expect(graph.hash).not.toBe(landed); // a point arriving is a change the viewer rebuilds for

    // the round that files the drop: the point keeps its identity and gains
    // its threads; a declined source remains as an ordinary point
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    const gardener = { kind: "model" as const, id: "gardener", invocation_id: "run-1" };
    const produced = { procedure: "intake-agent", version: "v1", invocation_id: "run-1", prompt_version: "p1" };
    appendAndProjectAssertion(root, createAssertionEvent({
      text: `[[${ada.id}|Ada]] wrote the dropped paper.`, entities: [ada],
      citations: [{ insertion_id: drop.id, quotes: [drop.body] }],
      author: gardener, confidence: "direct", created_at: "2026-09-06T10:00:00.000Z", produced_by: produced,
    }, new Map([[drop.id, drop]])));
    appendAndProjectDecline(root, createDeclineEvent({
      insertion_ids: [newer.id], reason: "nothing to keep", created_at: "2026-09-06T10:01:00.000Z",
      author: gardener, produced_by: produced,
    }, new Map([[newer.id, newer]])));
    graph = buildAssertionGraph(root);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([ada.id, `source:${drop.id}`, `source:${newer.id}`, `source:${directive.id}`].sort());
    expect(graph.nodes.find(n => n.id === `source:${newer.id}`)?.degree).toBe(0);
    expect(graph.nodes.find(n => n.id === `source:${newer.id}`)?.pending).toBeUndefined();
    const filed = graph.nodes.find((n) => n.id === `source:${drop.id}`)!;
    expect(filed.pending).toBeUndefined();
    expect(filed.degree).toBe(1);
    expect(graph.edges).toHaveLength(1);
  });

  test("an assertion-empty vault has an empty assertion projection", () => {
    expect(buildAssertionGraph(mkdtempSync(join(tmpdir(), "bb-assertion-graph-empty-"))))
      .toEqual({ nodes: [], edges: [], hash: "assertions-empty", projection: "assertions" });
  });

  test("source nodes wear the filed-by facet the feed's rows wear", () => {
    // The FILED BY filter's contract: a node and its feed row read the same
    // provenance (lib/sourceFeed.ts's insertionFiler), so one chip governs
    // both surfaces. Entity nodes carry no facet — nobody's filing.
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-graph-filer-"));
    const cited: SourceInsertion = {
      ...source("ins-filer", "Session transcript"),
      author: { kind: "agent", id: "claude-code" },
      envelope: {
        from: "claude-code",
        from_kind: "agent",
        source: "agent-chat",
        submitted_via: "claude code on Mac-mini.local",
      },
    };
    appendSourceInsertionEvent(root, cited);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `[[${ada.id}|Ada]] discussed sparse probes for the Atlas system.`,
      entities: [ada],
      citations: [{ insertion_id: cited.id, quotes: [cited.body] }],
      author: { kind: "model", id: "test-model", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-18T12:00:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[cited.id, cited]])));

    const graph = buildAssertionGraph(root);
    const node = graph.nodes.find((n) => n.group === "source")!;
    expect(node.band).toBe("agent");
    expect(node.from).toBe("claude-code");
    expect(node.via).toBe("claude code");
    expect(node.source).toBe("agent-chat");
    const entity = graph.nodes.find((n) => n.group === "entity")!;
    expect(entity.band).toBeUndefined();

    // The entity view's grounding sources wear the SAME facet — its
    // assertion rows name a source's filer beside the chip, and it must be
    // the filer the feed row and the graph node already show.
    const ref = assertionEntityView(root, assertionEntityPath(ada.id))!.assertions[0]!.sources[0]!;
    expect(ref.band).toBe("agent");
    expect(ref.from).toBe("claude-code");
    expect(ref.via).toBe("claude code");
    expect(ref.source).toBe("agent-chat");
  });

  test("memory topics join by citation: node per cited topic, edges to the cited assertions' entities (#445)", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-memory-graph-"));
    const cited = source("ins-cited", "Research meeting");
    appendSourceInsertionEvent(root, cited);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    const event = createAssertionEvent({
      text: `[[${ada.id}|Ada]] discussed sparse probes.`,
      entities: [ada],
      citations: [{ insertion_id: cited.id, quotes: [cited.body] }],
      author: { kind: "model", id: "test-model", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-18T12:00:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[cited.id, cited]]));
    appendAssertionEvent(root, event);
    mkdirSync(join(root, "memory"));
    // the index links the topic (the spine); the topic cites the assertion;
    // a stale citation and an uncited note draw NOTHING
    writeFileSync(join(root, "memory", "MEMORY.md"),
      "The working set.\n- [[memory/ada-research|Ada research]]\n");
    writeFileSync(join(root, "memory", "ada-research.md"),
      `Ada leads the probe work [[${event.id}]] [[ast_${"0".repeat(24)}]].\n`);
    writeFileSync(join(root, "memory", "uncited.md"), "Nothing grounded here.\n");

    const graph = buildAssertionGraph(root);
    const memory = graph.nodes.filter((node) => node.group === "memory");
    expect(memory.map((node) => node.id).sort()).toEqual(["memory/MEMORY.md", "memory/ada-research.md", "memory/uncited.md"]);
    // synthesis, not an arrival: no filer facets, so the FILED BY filter
    // never touches a memory node (feed.ts hides only labelled non-entities)
    for (const node of memory) {
      expect(node.path).toBe(node.id);
      expect(node.band).toBeUndefined();
      expect(node.via).toBeUndefined();
    }
    const edge = (a: string, b: string): boolean =>
      graph.edges.some((e) => [e.source, e.target].sort().join("|") === [a, b].sort().join("|"));
    expect(edge("memory/ada-research.md", ada.id)).toBe(true);      // citation-derived
    expect(edge("memory/MEMORY.md", "memory/ada-research.md")).toBe(true); // the spine
    // Unlinked memories remain available as workspace categories.
    expect(graph.nodes.find((node) => node.id === "memory/uncited.md")?.degree).toBe(0);
    // the stale ast id resolved to no entities and drew nothing extra
    expect(graph.edges.filter((e) => `${e.source}${e.target}`.includes("memory/ada-research.md"))).toHaveLength(2);
  });

  test("the viewer's window: latest-n truncation, honest total, header-only stub", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-window-"));
    const cited = source("ins-win", "Window source");
    appendSourceInsertionEvent(root, cited);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    for (const [hour, text] of [["10", "first"], ["11", "second"], ["12", "third"]] as const)
      appendAssertionEvent(root, createAssertionEvent({
        text: `[[${ada.id}|Ada]] ${text}.`,
        entities: [ada],
        citations: [{ insertion_id: cited.id, quotes: [cited.body] }],
        author: { kind: "model", id: "test-model", invocation_id: `run-${hour}` },
        confidence: "direct",
        created_at: `2026-08-18T${hour}:00:00.000Z`,
        produced_by: { procedure: "test", version: "v1" },
      }, new Map([[cited.id, cited]])));

    const view = assertionEntityView(root, assertionEntityPath(ada.id))!;
    const window = truncatedEntityView(view, 2);
    // the LATEST two, still in the log's ascending order — display order is
    // the client's — and the total names what the record actually holds
    expect(window.total).toBe(3);
    expect(window.assertions.map((a) => a.text)).toEqual(["Ada second.", "Ada third."]);
    // the /api/note stub beside it: the label header, none of the record
    const stub = projectedEntityMarkdown({ ...view, assertions: [] });
    expect(stub).toContain('title: "Ada Lovelace"');
    expect(stub).not.toContain("first");
  });

  test("the shared revision: appends become visible without manual cache invalidation", () => {
    // Engine appends project themselves, advancing the revision views read.
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-memo-"));
    const cited = source("ins-memo", "Memo source");
    appendSourceInsertionEvent(root, cited); projectSourceInsertion(root, cited);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    const assert = (text: string) => appendAndProjectAssertion(root, createAssertionEvent({
      text: `[[${ada.id}|Ada]] ${text}.`,
      entities: [ada],
      citations: [{ insertion_id: cited.id, quotes: [cited.body] }],
      author: { kind: "model", id: "test-model", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-18T12:00:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[cited.id, cited]])));

    assert("one");
    expect(assertionEntityView(root, assertionEntityPath(ada.id))!.assertions).toHaveLength(1);
    assert("two");
    expect(assertionEntityView(root, assertionEntityPath(ada.id))!.assertions).toHaveLength(2);
  });
});

test("declined agent transcripts remain ordinary graph sources and retain provider identity", async () => {
  const { recentFromSourceLog } = await import("../lib/sourceFeed");
  const root = mkdtempSync(join(tmpdir(), "bb-agent-history-"));
  const transcript: SourceInsertion = { ...source("ins_aaaaaaaaaaaaaaaaaaaaaaaa", "Dashboard session"),
    body: "user: Build the dashboard.\nassistant: Okay.\nuser: Show change over time.\nassistant: Okay.\nuser: Remove the separate HTML.",
    envelope: { source: "agent-chat", from: "codex", from_kind: "agent", key: "provider-thread", type: "reference" } };
  appendSourceInsertionEvent(root, transcript);
  projectSourceInsertion(root, transcript);
  appendAndProjectDecline(root, createDeclineEvent({
    insertion_ids: [transcript.id], reason: "No new facts", created_at: "2026-09-08T10:01:00.000Z",
    author: { kind: "model", id: "gardener", invocation_id: "run-1" },
    produced_by: { procedure: "intake-agent", version: "v1", invocation_id: "run-1", prompt_version: "p1" },
  }, new Map([[transcript.id, transcript]])));
  const graph = buildAssertionGraph(root);
  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]).toMatchObject({ group: "source", sessionId: "provider-thread", degree: 0 });
  expect(graph.nodes[0]?.pending).toBeUndefined();
  expect(recentFromSourceLog(root)[0]).toMatchObject({ sessionId: "provider-thread", status: "declined" });
});
