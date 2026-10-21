import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefingMemoFile, createNoteBriefingService, SOURCE_SUMMARY_TTL_MS } from "../lib/stages/briefing";
import { createNoteRelationService } from "../lib/stages/relation";
import { QuickQueue } from "../lib/run/quickQueue";
import { noteBriefingInput, sourceSummaryInput, type NoteBriefingInput } from "../lib/noteBriefing";
import type { BriefingModel } from "../lib/stages/quick";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { insertion, mdVault } from "./support/vault";

const roots: string[] = [];
const vault = () => { const root = mdVault({ files: { "vault.yaml": "{}" } }); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input: NoteBriefingInput = { items: [{ id: "source", path: "sources/example.md", title: "Atlas proposal", kind: "source", text: "A proposed second tool library." }], excluded: [], relationships: [], links: [] };
const request = { selected: [input.items[0]!.path], excluded: [], purpose: "source" as const };
const answer = { model: "fixture", text: JSON.stringify({ summary: "A proposed second tool library.", links: [] }) };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test("source summaries survive service restarts and graph changes, expire after 90 days, and follow source/model changes", async () => {
  const root = vault(); let calls = 0, current = structuredClone(input);
  const run: BriefingModel = async (_root, prompt) => {
    calls++;
    const supplied = JSON.parse(prompt);
    expect(supplied.links).toEqual([]);
    expect(prompt).not.toContain("Unrelated graph context");
    return answer;
  };
  const service = () => createNoteBriefingService(run, () => current);
  const first = await service()(root, request), file = briefingMemoFile(root, first.key);
  expect(calls).toBe(1);
  current.links.push({ id: "entity", path: "entity.md", title: "Unrelated graph context", evidence: [{ text: "A new claim." }] });
  expect(await service()(root, { ...request, scope: { lens: "lens_000000000001" } })).toEqual(first);
  expect(calls).toBe(1);
  const cached = JSON.parse(readFileSync(file, "utf8"));
  cached.generatedAt = new Date(Date.now() - SOURCE_SUMMARY_TTL_MS + 60_000).toISOString();
  writeFileSync(file, JSON.stringify(cached));
  await service()(root, request); expect(calls).toBe(1);
  cached.generatedAt = new Date(Date.now() - SOURCE_SUMMARY_TTL_MS - 1).toISOString();
  writeFileSync(file, JSON.stringify(cached));
  await service()(root, request); expect(calls).toBe(2);
  current.items[0]!.text = "The proposal was postponed.";
  expect((await service()(root, request)).key).not.toBe(first.key); expect(calls).toBe(3);
  // The full-text revision changes even when a long source's prompt excerpt does not.
  current.items[0]!.revision = "a-new-full-text-digest";
  await service()(root, request); expect(calls).toBe(4);
  writeFileSync(join(root, "vault.yaml"), "quick:\n  adapter: pi\n  provider: anthropic\n  model: fixture-other-model\n");
  await service()(root, request); expect(calls).toBe(5);
});

test("a source-only input omits neighborhood evidence and rejects non-source selections", () => {
  const root = vault(), source = insertion({ id: "ins_" + "4".repeat(24), title: "Atlas plan", body: "A proposed library." });
  appendSourceInsertionEvent(root, source);
  const read = noteBriefingInput(root, { ...request, selected: [insertionEventRel(source)] });
  expect(read.items[0]!.text).toBe(source.body);
  expect(read.links).toEqual([]);
  expect(read.relationships).toEqual([]);
  expect(() => sourceSummaryInput([{ ...input.items[0]!, kind: "entity" }])).toThrow("Choose one source");
  expect(() => sourceSummaryInput([...input.items, ...input.items])).toThrow("Choose one source");
});

test("briefings and hovers share capacity, keep another reader's job, and discard only abandoned queued work", async () => {
  const root = vault(), queue = new QuickQueue(1), gate = deferred(), calls: string[] = [];
  const held = queue.run(async () => gate.promise);
  const run: BriefingModel = async (_root, prompt, _preview, _system, options) => queue.run(async () => {
    calls.push(prompt); return answer;
  }, options?.queueSignal);
  const generate = createNoteBriefingService(run, (_root, req) => ({ ...input, items: [{ ...input.items[0]!, id: String(req), path: String(req) }] }));
  const a = new AbortController(), b = new AbortController(), cancelled = new AbortController();
  const first = generate(root, "shared", () => {}, a.signal);
  const second = generate(root, "shared", () => {}, b.signal);
  const abandoned = generate(root, "abandoned", () => {}, cancelled.signal);
  const results = Promise.allSettled([first, second, abandoned]);
  await Promise.resolve();
  a.abort(); cancelled.abort();
  const relation = createNoteRelationService(async (_root, _prompt, _preview, _system, options) => queue.run(async () => {
    calls.push("hover"); return { model: "fixture", text: '{"relation":"records their proposal"}' };
  }, options?.queueSignal), () => ({ focus: input.items[0]!, hovered: { ...input.items[0]!, id: "neighbor" }, direct: ["Proposal"], shared: [] }));
  const hoverController = new AbortController();
  const hover = relation(root, "source", "neighbor", hoverController.signal).catch(error => error);
  await Promise.resolve(); hoverController.abort();
  expect(calls).toEqual([]);
  gate.resolve(); await held;
  expect((await results).map(r => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
  expect((await hover).name).toBe("AbortError");
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toContain("abandoned");
  await generate(root, "shared"); expect(calls).toHaveLength(1);
  // A cancelled queue entry is not a cached error: returning can ask again.
  await generate(root, "abandoned"); expect(calls).toHaveLength(2);
});

test("navigation during active work lets it finish, reuse the same call, and persist the summary", async () => {
  const root = vault(), queue = new QuickQueue(1), gate = deferred(), started = deferred(); let calls = 0;
  const run: BriefingModel = async (_root, _prompt, _preview, _system, options) => queue.run(async () => {
    calls++; started.resolve(); await gate.promise; return answer;
  }, options?.queueSignal);
  const generate = createNoteBriefingService(run, () => input), controller = new AbortController();
  const first = generate(root, request, () => {}, controller.signal);
  await started.promise; controller.abort();
  const returning = generate(root, request);
  gate.resolve(); expect(await first).toEqual(await returning);
  await createNoteBriefingService(run, () => input)(root, request);
  expect(calls).toBe(1);
});

test("navigation before input is ready never submits work, and failures can be retried", async () => {
  const root = vault(), gate = deferred(); let calls = 0;
  const generate = createNoteBriefingService(async () => { calls++; if (calls === 1) throw Error("Unavailable"); return answer; }, async () => { await gate.promise; return input; });
  const controller = new AbortController(), pending = generate(root, request, () => {}, controller.signal).catch(error => error);
  controller.abort(); gate.resolve();
  expect((await pending).name).toBe("AbortError"); expect(calls).toBe(0);
  await expect(generate(root, request)).rejects.toThrow("Unavailable");
  await generate(root, request); expect(calls).toBe(2);
});
