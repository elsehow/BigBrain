import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextConnections } from "../lib/contextConnections";
import { connectedMentions } from "../web/ui/src/lib/pilotMentionSuggestions";
import { briefingPrompt } from "../lib/noteBriefing";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { projectNotes } from "../lib/assertionProjection";
import { assertionEntityId, createAssertionEvent, appendAssertionEvent } from "../lib/assertionLog";
import { assertionEntityPath } from "../lib/assertionEntityView";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { createNoteBriefingService, noteBriefingInput, parseNoteBriefing, type NoteBriefingInput } from "../lib/noteBriefing";
import { explicitNoteLinks, noteLinkResolver, readMarkdownNote } from "../lib/markdownGraph";
import { declareOwner } from "./support/identity";
import { insertion, mdVault, gitVault } from "./support/vault";
import { connectionRankingFixture } from "./support/connectionRankingFixture";

const roots: string[] = [];
const vault = (files: Record<string, string> = {}) => { const root = mdVault({ files: { "vault.yaml": "{}", ...files } }); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function linkedVault() {
  const root = vault();
  const ada = { id: assertionEntityId("Ada"), label: "Ada" };
  const atlas = { id: assertionEntityId("Atlas"), label: "Atlas" };
  const source = insertion({ id: "ins_" + "1".repeat(24), title: "Project meeting", body: "Ada manages Atlas.", imported_path: "references/meeting.md" });
  appendSourceInsertionEvent(root, source);
  const event = createAssertionEvent({ text: `[[${ada.id}|Ada]] manages [[${atlas.id}|Atlas]].`, entities: [ada, atlas],
    citations: [{ insertion_id: source.id, quotes: [source.body] }], confidence: "direct", author: { kind: "model", id: "test", invocation_id: "test" },
    created_at: "2026-09-01T00:00:00Z", produced_by: { procedure: "test", version: "1" } }, new Map([[source.id, source]]));
  appendAssertionEvent(root, event);
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "memory", "project.md"), `# Project\n\n[[${event.id}]]\n\n${"Padding. ".repeat(4000)}\n\n[[${ada.id}|Ada]] coordinates this. [Meeting](../references/meeting.md) records it. [[memory/next]] covers next steps.\n`);
  writeFileSync(join(root, "memory", "next.md"), "# Next steps\nNothing else yet.");
  return { root, ada, atlas, source };
}

test("entities, sources and Markdown share the graph's complete direct connections and grounding", () => {
  const { root, ada, atlas, source } = linkedVault();
  const graph = buildAssertionGraph(root);
  for (const path of [assertionEntityPath(ada.id), insertionEventRel(source), "memory/project.md"]) {
    const input = noteBriefingInput(root, path);
    const neighbors = graph.edges.flatMap(e => e.source === input.items[0]!.id ? [e.target] : e.target === input.items[0]!.id ? [e.source] : []);
    expect(input.links.map(l => l.id).sort()).toEqual(neighbors.sort());
    const mentions = connectedMentions(graph, [input.items[0]!.id], Object.fromEntries(input.items.map(item => [item.id, item.text])));
    expect(input.links.map(l => l.path)).toEqual(mentions.items.map(item => item.id));
    expect(input.links.map(l => l.id)).toEqual(contextConnections(graph, [input.items[0]!.id], [], Object.fromEntries(input.items.map(item => [item.id, item.text]))).map(({ node }) => node.id));
    expect(input.links.every(l => l.evidence.length > 0)).toBe(true);
  }
  const memory = noteBriefingInput(root, "memory/project.md");
  expect(memory.links.map(l => l.id)).toEqual(expect.arrayContaining([ada.id, atlas.id, `source:${source.id}`, "memory/next.md"]));
  expect(memory.links.find(l => l.id === ada.id)?.evidence.some(e => e.text.includes("coordinates"))).toBe(true);
  expect(graph.nodes.filter(n => n.title === "Project meeting")).toHaveLength(1);
});

test("an existing Markdown dossier resolves to its canonical entity rather than a duplicate or empty briefing", () => {
  const { root, ada } = linkedVault();
  mkdirSync(join(root, "entities"));
  writeFileSync(join(root, "entities", "ada.md"), "# Ada\n\n[[memory/project]] describes the project.");
  const input = noteBriefingInput(root, "entities/ada.md");
  expect(input.items[0]!.id).toBe(ada.id);
  expect(input.items[0]!.kind).toBe("entity");
  expect(input.links.length).toBeGreaterThan(0);
  expect(buildAssertionGraph(root).nodes.filter(n => n.title === "Ada")).toHaveLength(1);
});

test("dropped Markdown has explicit links before it has assertions, with reciprocal memory backlinks", () => {
  const root = vault({ "memory/topic.md": "# Topic\nA useful topic." });
  const source = insertion({ id: "ins_" + "2".repeat(24), title: "Dropped note", body: "See [[memory/topic|Topic]] for context." });
  appendSourceInsertionEvent(root, source);
  const input = noteBriefingInput(root, insertionEventRel(source));
  expect(input.links.map(l => l.path)).toEqual(["memory/topic.md"]);
  expect(noteBriefingInput(root, "memory/topic.md").links.map(l => l.path)).toEqual([insertionEventRel(source)]);
});

test("Markdown resolution handles aliases, relative/encoded paths, anchors and reference links, ignoring code and unresolved targets", () => {
  const nodes = [{ id: "a", path: "memory/a note.md", title: "A", group: "memory", degree: 0 },
    { id: "b", path: "memory/b.md", title: "B", group: "memory", degree: 0 }];
  const resolve = noteLinkResolver(nodes, [["ent_old", "b"]]);
  const links = explicitNoteLinks({ id: "doc", path: "memory/doc.md", title: "Doc", body: [
    "See [A](a%20note.md#section), [[ent_old|B]], and [reference][ref].", "", "[ref]: b.md", "",
    "`[[missing]]` and `[fake](b.md)`", "```", "[[memory/b]]", "```", "[[missing]] [web](https://example.com) ![image](b.md)",
  ].join("\n") }, resolve);
  expect(links.map(l => l.target)).toEqual(["a", "b", "b"]);
});

test("briefing reader rejects traversal and symlinks outside the content tree", () => {
  const root = vault({ "memory/okay.md": "Okay", "secret.md": "Private" });
  symlinkSync(join(root, "secret.md"), join(root, "memory", "escape.md"));
  for (const path of ["memory/../secret.md", "memory/escape.md", "/etc/passwd", "vault.yaml"]) expect(readMarkdownNote(root, path)).toBeUndefined();
});

const input: NoteBriefingInput = { items: [{ id: "item", path: "memory/item.md", title: "Item", kind: "markdown", text: "Project context." }], excluded: [], relationships: [],
  links: ["a", "b"].map(id => ({ id, path: `memory/${id}.md`, title: id.toUpperCase(), evidence: [{ path: "memory/item.md", text: `${id} manages the project.` }] })) };
const output = { summary: "A note about the project and its managers.", links: ["b", "a"].map(id => ({ id, description: "manages the project", evidence: [1] })) };

test("only outbound memory links confer support; repeated mentions, aliases and assertion citations count once", () => {
  const { root, ada, atlas } = linkedVault();
  const initial = buildAssertionGraph(root);
  const score = (graph: ReturnType<typeof buildAssertionGraph>, id: string) => graph.nodes.find(n => n.id === id)?.memorySupport ?? 0;
  // Project links to Ada, Atlas (citation), the meeting and Next steps.
  expect(score(initial, ada.id)).toBeCloseTo(0.5);
  expect(score(initial, atlas.id)).toBeCloseTo(0.5);
  writeFileSync(join(root, "memory", "focused.md"), `# Focused\n[[${ada.id}|Ada]] [[${assertionEntityPath(ada.id)}|Ada again]]`);
  projectNotes(root, ["memory/focused.md"]);
  const repeated = buildAssertionGraph(root);
  expect(score(repeated, ada.id)).toBeCloseTo(1.5);
  expect(score(repeated, atlas.id)).toBeCloseTo(0.5);
  // A source that links TO a memory does not receive that memory's support.
  const incoming = insertion({ id: "ins_" + "7".repeat(24), title: "Incoming", body: "See [[memory/focused]]." });
  appendSourceInsertionEvent(root, incoming);
  expect(score(buildAssertionGraph(root), `source:${incoming.id}`)).toBe(0);
  // Flipping a link between two memories leaves topology/weight alone but
  // changes salience; the viewer's hash must invalidate that old ranking.
  const pairRoot = vault({ "memory/a.md": "# A\n[[memory/b]]", "memory/b.md": "# B" });
  const before = buildAssertionGraph(pairRoot);
  writeFileSync(join(pairRoot, "memory", "a.md"), "# A");
  writeFileSync(join(pairRoot, "memory", "b.md"), "# B\n[[memory/a]]");
  projectNotes(pairRoot, ["memory/a.md", "memory/b.md"]);
  const after = buildAssertionGraph(pairRoot);
  expect(after.edges).toEqual(before.edges);
  expect(after.hash).not.toBe(before.hash);
  expect(score(after, "memory/a.md")).toBe(1);
  expect(score(after, "memory/b.md")).toBe(0);
});

test("inbound memory context survives the ten-link cutoff, respects exclusions, and invalidates cached briefings", async () => {
  const { root, ada } = linkedVault();
  mkdirSync(join(root, "entities"));
  for (let i = 0; i < 12; i++) writeFileSync(join(root, "entities", `extra-${i}.md`), `# Extra ${i}\n[[${ada.id}|Ada]] [[entities/extra-${(i + 1) % 12}]] [[entities/extra-${(i + 2) % 12}]]`);
  const full = noteBriefingInput(root, ada.id);
  expect(full.memories?.map(m => m.path)).toContain("memory/project.md");
  // Force the memory outside the description budget to exercise independent grounding.
  full.links.sort((a, b) => Number(a.kind === "memory") - Number(b.kind === "memory"));
  const { input: supplied, prompt } = briefingPrompt(full);
  expect(supplied.links).toHaveLength(10);
  expect(supplied.links.map(l => l.path)).not.toContain("memory/project.md");
  expect(JSON.parse(prompt).memories[0].evidence.some(e => e.text.includes("coordinates"))).toBe(true);
  const excluded = noteBriefingInput(root, { selected: [ada.id], excluded: ["memory/project.md"] });
  expect(excluded.memories).toEqual([]);
  expect(noteBriefingInput(root, "memory/next.md").memories?.map(m => m.path)).toEqual(["memory/project.md"]);
  expect(noteBriefingInput(root, "memory/project.md").memories).toEqual([]);
  let calls = 0;
  const generate = createNoteBriefingService(async (_root, text) => {
    calls++;
    return { model: "test", text: JSON.stringify({ summary: "Ada coordinates the project.", links: JSON.parse(text).links.map(l => ({ id: l.id, description: "documents their work", evidence: [1] })) }) };
  }, () => full);
  await generate(root, ada.id);
  await generate(root, ada.id);
  expect(calls).toBe(1);
  full.memories![0]!.evidence[0]!.text += " Updated context.";
  await generate(root, ada.id);
  expect(calls).toBe(2);
});

test("memory context covers multiple selections within the existing total item-text budget", () => {
  const full: NoteBriefingInput = { ...input, items: ["a", "b"].map(id => ({ ...input.items[0]!, id, text: "x".repeat(16_000) })),
    memories: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, path: `memory/m${i}.md`, title: `Memory ${i}`, selected: [i === 5 ? "b" : "a"],
      evidence: [{ text: "context ".repeat(1000), selected: [i === 5 ? "b" : "a"] }] })) };
  const parsed = JSON.parse(briefingPrompt(full).prompt);
  expect(parsed.memories).toHaveLength(3);
  expect(parsed.memories[1].title).toBe("Memory 5");
  expect(parsed.memories.flatMap(m => m.selected)).toContain("S2");
  const memoryChars = parsed.memories.reduce((n, m) => n + m.evidence.reduce((sum, e) => sum + e.text.length, 0), 0);
  expect(memoryChars).toBe(3000);
  expect(memoryChars + parsed.items.reduce((n, item) => n + item.text.length, 0)).toBe(16_000);
  expect(parsed.links).toHaveLength(input.links.length);
});

test("input rank is authoritative and invalid, duplicated, omitted or ungrounded links cannot be cached", () => {
  expect(parseNoteBriefing(JSON.stringify(output), input).links.map(l => l.id)).toEqual(input.links.map(l => l.id));
  for (const links of [output.links.slice(0, 1), [output.links[0], output.links[0]], [...output.links, { id: "invented", description: "is invented", evidence: [1] }],
    [{ ...output.links[0], evidence: [2] }, output.links[1]], [{ ...output.links[0], evidence: [] }, output.links[1]]])
    expect(() => parseNoteBriefing(JSON.stringify({ ...output, links }), input)).toThrow();
});

test("new selections start while earlier briefings run, including detached readers, and duplicates still share work", async () => {
  const root = vault();
  let calls = 0;
  const releases: (() => void)[] = [];
  const generate = createNoteBriefingService(async () => {
    calls++;
    await new Promise<void>(resolve => releases.push(resolve));
    return { model: "test", text: JSON.stringify({ summary: "A project note.", links: [] }) };
  }, (_root, request) => ({ items: [{ id: String(request), path: String(request), title: "Project", kind: "memory", text: "Project context." }], excluded: [], relationships: [], links: [] }));
  const controller = new AbortController();
  const requests = [generate(root, "memory/0.md", () => {}, controller.signal)];
  controller.abort(); // Navigating away detaches the reader, but warms the cache.
  for (let i = 1; i < 6; i++) requests.push(generate(root, `memory/${i}.md`));
  requests.push(generate(root, "memory/0.md"));
  const results = Promise.allSettled(requests);
  await Bun.sleep(0);
  const started = calls;
  for (const release of releases) release();
  const settled = await results;
  expect(started).toBe(6);
  expect(settled.every(result => result.status === "fulfilled")).toBe(true);
  expect(settled[0]).toEqual(settled[6]);
  await generate(root, "memory/0.md");
  expect(calls).toBe(6);
});

test("one call supplies summary and every link, concurrent readers share it, and evidence/link changes refresh the cache", async () => {
  const root = vault();
  let current = structuredClone(input), calls = 0;
  const generate = createNoteBriefingService(async (_root, prompt) => {
    calls++;
    const supplied = JSON.parse(prompt) as NoteBriefingInput;
    await Bun.sleep(5);
    return { model: "test-quick", text: JSON.stringify({ ...output, links: [...supplied.links].reverse().map(l => ({ id: l.id, description: "manages the project", evidence: [1] })) }) };
  }, () => current);
  const [a, b] = await Promise.all([generate(root, input.items[0]!.path), generate(root, input.items[0]!.path)]);
  expect(a).toEqual(b); expect(calls).toBe(1);
  await generate(root, input.items[0]!.path); expect(calls).toBe(1);
  // Pre-fix caches kept the model's order. Read them in rank order without
  // another model call or losing any validated descriptions.
  const cacheFile = join(root, ".state", "note-briefings", readdirSync(join(root, ".state", "note-briefings"))[0]!);
  const oldCache = JSON.parse(readFileSync(cacheFile, "utf8"));
  oldCache.links.reverse();
  writeFileSync(cacheFile, JSON.stringify(oldCache));
  expect((await generate(root, input.items[0]!.path)).links.map(l => l.id)).toEqual(current.links.map(l => l.id));
  expect(calls).toBe(1);
  current.links[0]!.evidence[0]!.text = "A supports the project.";
  await generate(root, input.items[0]!.path); expect(calls).toBe(2);
  current = { ...current, links: current.links.slice(0, 1) };
  expect((await generate(root, input.items[0]!.path)).links).toHaveLength(1); expect(calls).toBe(3);
  expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe("{}");
});


test("a large neighborhood sends only the top ten to Quick, then appends every remaining link in candidate order", async () => {
  const root = vault();
  const full: NoteBriefingInput = { ...input, links: Array.from({ length: 600 }, (_, i) => ({
    id: `node-${i}`, path: `memory/node-${i}.md`, title: `Node ${i}`, evidence: [{ text: `Node ${i} supports this project.` }],
  })) };
  let calls = 0;
  const generate = createNoteBriefingService(async (_root, prompt) => {
    calls++;
    const given = JSON.parse(prompt);
    expect(given.links.map((l: { title: string }) => l.title)).toEqual(full.links.slice(0, 10).map(l => l.title));
    expect(prompt).not.toContain("Node 599");
    return { model: "quick", text: JSON.stringify({ summary: output.summary, links: [...given.links].reverse().map(l => ({
      id: l.id, description: "supports this project", evidence: [1],
    })) }) };
  }, () => full);
  const result = await generate(root, full.items[0]!.path);
  expect(calls).toBe(1);
  expect(result.links).toHaveLength(600);
  expect(result.links.filter(l => l.description)).toHaveLength(10);
  expect(result.links.slice(0, 10).map(l => l.id)).toEqual(full.links.slice(0, 10).map(l => l.id));
  expect(result.links.slice(10).map(l => l.id)).toEqual(full.links.slice(10).map(l => l.id));
  expect(briefingPrompt({ ...full, links: [] }).input.links).toEqual([]);
});

test("local relevance chooses the ten supplied links before the model call", async () => {
  const graph = connectionRankingFixture(8);
  const root = vault(Object.fromEntries(graph.nodes.map(node => [node.path, `# ${node.title}\n\n` +
    graph.edges.filter(edge => edge.source === node.id).map(edge => `See [[entities/${edge.target}|${edge.target}]].`).join("\n")])));
  const generate = createNoteBriefingService(async (_root, prompt) => {
    const supplied = JSON.parse(prompt);
    expect(supplied.links).toHaveLength(10);
    expect(supplied.links.map(link => link.title)).not.toContain("hub");
    expect(supplied.links.map(link => link.title)).toEqual(expect.arrayContaining(["clinic", "partner", "school"]));
    return { model: "test", text: JSON.stringify({ summary: "A local neighborhood with a distant hub connection.",
      links: supplied.links.map(link => ({ id: link.id, description: "provides local context", evidence: [1] })) }) };
  });
  const result = await generate(root, "entities/focus.md");
  expect(result.links.at(-1)?.title).toBe("hub");
  expect(result.links.at(-1)?.description).toBeUndefined();
});


test("the declared owner and their named memory index are absent before the top-ten sample", () => {
  const root = gitVault({ files: { "vault.yaml": "{}", "memory/MEMORY.md": "# Ada Owner\n\n[[memory/topic]]", "memory/topic.md": "# Topic\n\n[[memory/MEMORY]] and [[memory/other]]", "memory/other.md": "# Other\n" } });
  roots.push(root);
  const owner = declareOwner(root, { account: "owner", name: "Ada Owner", verified_email: "ada@example.com" });
  writeFileSync(join(root, "memory", "topic.md"), `# Topic\n\n[[${owner.entity_id}|Ada Owner]] is the owner. [[memory/MEMORY]] and [[memory/other]]`);
  const graph = buildAssertionGraph(root);
  expect(graph.nodes.some(n => n.id === owner.entity_id || n.path === "memory/MEMORY.md")).toBe(false);
  expect(graph.nodes.find(n => n.path === "memory/topic.md")?.memorySupport).toBeUndefined();
  expect(graph.nodes.find(n => n.path === "memory/other.md")?.memorySupport).toBe(1);
  const input = noteBriefingInput(root, "memory/topic.md");
  expect(input.links.map(l => l.path)).toEqual(["memory/other.md"]);
  expect(input.memories).toEqual([]);
  expect(briefingPrompt(input).input.links.map(l => l.path)).toEqual(["memory/other.md"]);
});

test("joint briefings carry direct relationship evidence and deduplicated shared neighbors, with exclusions applied before sampling", () => {
  const { root, ada, atlas, source } = linkedVault();
  const state = { selected: [assertionEntityPath(atlas.id), ada.id, assertionEntityPath(ada.id)], excluded: [] };
  const full = noteBriefingInput(root, state);
  expect(full.items.map(item => item.id)).toEqual([ada.id, atlas.id].sort());
  expect(full.relationships).toHaveLength(1);
  expect(full.relationships[0]!.evidence.some(e => e.text.includes("manages"))).toBe(true);
  expect(full.links.map(link => link.id)).not.toContain(ada.id);
  expect(full.links.map(link => link.id)).not.toContain(atlas.id);
  for (const link of full.links) expect(link.selected).toEqual([ada.id, atlas.id].sort());
  const supplied = JSON.parse(briefingPrompt(full).prompt);
  expect(supplied.items.map(item => item.id)).toEqual(["S1", "S2"]);
  expect(supplied.summaryTask).toMatchObject({ mode: "direct_relationship",
    relationships: [{ from: "S1", to: "S2" }] });
  expect(supplied.links.every(link => link.selected.join() === "S1,S2")).toBe(true);
  for (const link of supplied.links) expect([...new Set(link.evidence.flatMap(e => e.selected))].sort()).toEqual(["S1", "S2"]);
  const excluded = noteBriefingInput(root, { ...state, excluded: [insertionEventRel(source)] });
  expect(excluded.links.some(link => link.id === `source:${source.id}`)).toBe(false);
  expect(excluded.excluded).toEqual([`source:${source.id}`]);
  expect(noteBriefingInput(root, { selected: [ada.id, atlas.id], excluded: [assertionEntityPath(ada.id)] }).items.map(item => item.id)).toEqual([atlas.id]);
});

test("mixed source and Markdown selections share evidence; disconnected selections retain their own links without invented paths", () => {
  const { root, ada, source } = linkedVault();
  const mixed = noteBriefingInput(root, { selected: ["memory/project.md", insertionEventRel(source)], excluded: [] });
  expect(mixed.items.map(item => item.kind).sort()).toEqual(["markdown", "source"]);
  expect(mixed.relationships).toHaveLength(1);
  expect(mixed.links.find(link => link.id === ada.id)?.selected).toHaveLength(2);
  expect(mixed.links.find(link => link.id === "memory/next.md")?.selected).toEqual(["memory/project.md"]);
  const isolatedRoot = vault({ "memory/a.md": "# A\n[[memory/a-leaf]]", "memory/a-leaf.md": "# A leaf", "memory/b.md": "# B\n[[memory/b-leaf]]", "memory/b-leaf.md": "# B leaf" });
  const disconnected = noteBriefingInput(isolatedRoot, { selected: ["memory/a.md", "memory/b.md"], excluded: [] });
  expect(disconnected.relationships).toEqual([]);
  expect(disconnected.links.map(link => link.selected)).toEqual([["memory/a.md"], ["memory/b.md"]]);
  expect(JSON.parse(briefingPrompt(disconnected).prompt).summaryTask).toEqual({ mode: "shared_context" });
});

test("briefing prompts isolate direct summary evidence before the wider neighborhood", () => {
  const direct: NoteBriefingInput = { ...input,
    items: [{ id: "employer", path: "entities/employer.md", title: "Employer", kind: "entity", text: "An employer." },
      { id: "health", path: "memory/health.md", title: "Health", kind: "markdown", text: "A health note." }],
    relationships: [{ from: "employer", to: "health", evidence: [{ text: "A group plan was expected but coverage was unconfirmed." }] }],
  };
  const prompt = JSON.parse(briefingPrompt(direct).prompt);
  expect(Object.keys(prompt)[0]).toBe("summaryTask");
  expect(prompt.summaryTask).toEqual({ mode: "direct_relationship", relationships: [{ from: "S1", to: "S2",
    evidence: [{ text: "A group plan was expected but coverage was unconfirmed.", kind: "markdown link" }] }] });
  expect(prompt.relationships).toBeUndefined();
  expect(JSON.parse(briefingPrompt(input).prompt).summaryTask).toEqual({ mode: "identity" });
});

test("selection cache is independent of gesture order and aliases, and changes with exclusions or selected membership", async () => {
  const { root, ada, atlas, source } = linkedVault();
  let calls = 0;
  const generate = createNoteBriefingService(async (_root, prompt) => {
    calls++;
    const supplied = JSON.parse(prompt);
    return { model: "test", text: JSON.stringify({ summary: "Ada manages Atlas.", links: supplied.links.map(link => ({ id: link.id, description: "documents their project", evidence: [1] })) }) };
  });
  const first = await generate(root, { selected: [atlas.id, ada.id], excluded: [] });
  expect(await generate(root, { selected: [assertionEntityPath(ada.id), atlas.id, ada.id], excluded: [] })).toEqual(first);
  expect(calls).toBe(1);
  const pruned = await generate(root, { selected: [ada.id, atlas.id], excluded: [insertionEventRel(source)] });
  expect(pruned.key).not.toBe(first.key);
  expect(pruned.links.some(link => link.id === `source:${source.id}`)).toBe(false);
  await generate(root, { selected: [atlas.id], excluded: [ada.id] });
  expect(calls).toBe(3);
  expect((await generate(root, { selected: [ada.id, atlas.id], excluded: [] })).key).toBe(first.key);
  expect(calls).toBe(3);
});

test("multiple selections keep total prompt context bounded and give both anchors evidence among prolific passages", () => {
  const full: NoteBriefingInput = { ...input,
    items: ["a", "b"].map(id => ({ id, path: `${id}.md`, title: id, kind: "entity", text: "x".repeat(16_000) })),
    relationships: [{ from: "a", to: "b", evidence: Array.from({ length: 100 }, () => ({ text: "r".repeat(16_000) })) }],
    links: Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, path: `n${i}.md`, title: `N${i}`, selected: ["a", "b"],
      evidence: Array.from({ length: 100 }, (_, j) => ({ text: "e".repeat(16_000), selected: [j === 99 ? "b" : "a"] })),
    })),
  };
  const { prompt, input: supplied } = briefingPrompt(full);
  const parsed = JSON.parse(prompt);
  expect(parsed.items.reduce((n, item) => n + item.text.length, 0)).toBe(16_000);
  expect(parsed.links).toHaveLength(10);
  expect(supplied.links[0]!.evidence.flatMap(e => e.selected)).toContain("b");
  // The ten-link shortlist shares the previous five-link evidence budget.
  expect(supplied.links.reduce((sum, link) => sum + link.evidence.reduce((n, e) => n + e.text.length, 0), 0)).toBeLessThanOrEqual(15_030);
  expect(prompt.length).toBeLessThan(40_000);
  expect(prompt).not.toContain('"N599"');
});

test("streamed summaries decode split JSON strings, ignore link payloads, and reject markup", async () => {
  const { noteBriefingPreview } = await import("../lib/noteBriefing");
  expect(noteBriefingPreview('{"summary":"Ada manages')).toBe("Ada manages");
  expect(noteBriefingPreview('{"summary":"Ada’s \\"quoted\\" role","links":[')).toBe('Ada’s "quoted" role');
  expect(noteBriefingPreview('{"summary":"\\u00')).toBeUndefined();
  expect(noteBriefingPreview('{"summary":"\\u00e9')).toBe("é");
  expect(noteBriefingPreview('{"summary":"<script>')).toBeUndefined();
  expect(noteBriefingPreview('{"links":[],"summary":"Later"}')).toBeUndefined();
});

test("concurrent readers share live summary text, late subscribers catch up, and aborted readers detach", async () => {
  const root = vault();
  let push: (text: string) => void = () => {};
  let finish: (result: { model: string; text: string }) => void = () => {};
  const generate = createNoteBriefingService(async (_root, _prompt, preview) => {
    push = preview;
    return new Promise(resolve => { finish = resolve; });
  }, () => input);
  const a: string[] = [], b: string[] = [];
  const controller = new AbortController();
  const first = generate(root, input.items[0]!.path, text => a.push(text), controller.signal);
  await Promise.resolve(); // input preparation may run off the request thread
  push('{"summary":"Ada');
  const second = generate(root, input.items[0]!.path, text => b.push(text));
  await Promise.resolve();
  expect(b).toEqual(["Ada"]);
  controller.abort();
  push('{"summary":"Ada manages Atlas');
  expect(a).toEqual(["Ada"]);
  expect(b).toEqual(["Ada", "Ada manages Atlas"]);
  finish({ model: "test", text: JSON.stringify(output) });
  expect(await first).toEqual(await second);
});

test("unread overviews use a distinct prompt and cache without changing normal summaries", async () => {
  const root = vault(); const systems: string[] = [];
  const generate = createNoteBriefingService(async (_root, prompt, _preview, system) => {
    systems.push(system!);
    return { model: "test", text: JSON.stringify({ summary: "A date needs choosing.", links: JSON.parse(prompt).links.map((l: any) => ({ id: l.id, description: "documents the decision", evidence: [1] })) }) };
  }, () => input);
  const selection = { selected: [input.items[0]!.id], excluded: [] };
  const normal = await generate(root, selection);
  const unread = await generate(root, { ...selection, purpose: "unread" });
  expect(unread.key).not.toBe(normal.key);
  expect(systems[0]).not.toContain("explicitly opened as unread");
  expect(systems[1]).toContain("explicitly opened as unread");
  await generate(root, selection); await generate(root, { ...selection, purpose: "unread" });
  expect(systems).toHaveLength(2);
});

test("memory preview warming is sequential, reuses cached Quick output and tolerates one failed memory", async () => {
  const { warmMemoryBriefings } = await import("../lib/memoryBriefings");
  const { root } = linkedVault();
  let calls = 0;
  const generate = createNoteBriefingService(async (_root, prompt) => {
    calls++;
    const supplied = JSON.parse(prompt);
    return { model: "test", text: JSON.stringify({ summary: "A memory preview.", links: supplied.links.map(l => ({ id: l.id, description: "related context", evidence: [1] })) }) };
  });
  const first = await warmMemoryBriefings(root, generate);
  expect(first.failures).toEqual([]);
  expect(first.warmed).toBeGreaterThan(0);
  const generated = calls;
  await warmMemoryBriefings(root, generate);
  expect(calls).toBe(generated);
  const visited: string[] = [];
  const failed = await warmMemoryBriefings(root, async (r, request) => {
    visited.push(String(request));
    if (visited.length === 1) throw new Error("fixture failure");
    return generate(r, request);
  });
  expect(failed.failures).toHaveLength(1);
  expect(visited.length).toBe(first.warmed);
});
