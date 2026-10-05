import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertionEntityId, createAssertionEvent, appendAssertionEvent } from "../lib/assertionLog";
import { assertionEntityPath } from "../lib/assertionEntityView";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { briefingCacheFile } from "../lib/noteBriefing";
import { createNoteRelationService, noteRelationInput, noteRelationPrompt, parseNoteRelation, type NoteRelationInput } from "../lib/noteRelation";
import { insertion, mdVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ada = { id: assertionEntityId("Ada"), label: "Ada" };
const atlas = { id: assertionEntityId("Atlas"), label: "Atlas" };
const bo = { id: assertionEntityId("Bo"), label: "Bo" };

/** Ada manages Atlas and Bo funds it: Ada and Atlas are linked directly,
 * Ada and Bo only through Atlas. */
function vault() {
  const root = mdVault({ files: { "vault.yaml": "{}" } });
  roots.push(root);
  const claims = [[`[[${ada.id}|Ada]] manages [[${atlas.id}|Atlas]].`, [ada, atlas]], [`[[${bo.id}|Bo]] funds [[${atlas.id}|Atlas]].`, [bo, atlas]]] as const;
  claims.forEach(([text, entities], i) => {
    const source = insertion({ id: `ins_${String(i + 1).repeat(24)}`, title: `Meeting ${i + 1}`, body: text.replace(/\[\[[^|]+\|([^\]]+)\]\]/g, "$1") });
    appendSourceInsertionEvent(root, source);
    appendAssertionEvent(root, createAssertionEvent({ text, entities: [...entities], citations: [{ insertion_id: source.id, quotes: [source.body] }],
      confidence: "direct", author: { kind: "model", id: "test", invocation_id: "test" }, created_at: `2026-09-0${i + 1}T00:00:00Z`,
      produced_by: { procedure: "test", version: "1" } }, new Map([[source.id, source]])));
  });
  return root;
}

test("the open note and the hovered one keep their roles whatever their sort order or spelling", () => {
  const root = vault();
  for (const [focus, hovered] of [[ada.id, atlas.id], [assertionEntityPath(atlas.id), assertionEntityPath(ada.id)]] as const) {
    const input = noteRelationInput(root, focus, hovered);
    expect([input.focus.title, input.hovered.title]).toEqual(focus.includes(ada.id) ? ["Ada", "Atlas"] : ["Atlas", "Ada"]);
    expect(input.direct).toEqual(["Ada manages Atlas."]);
    expect(input.shared).toEqual([]);
  }
  expect(() => noteRelationInput(root, ada.id, assertionEntityPath(ada.id))).toThrow("different note");
});

test("without a direct link the relation is told what the two share, never a direct row", () => {
  const input = noteRelationInput(vault(), ada.id, bo.id);
  expect(input.direct).toEqual([]);
  expect(input.shared.map(link => link.title)).toEqual(["Atlas"]);
  const prompt = JSON.parse(noteRelationPrompt(input));
  expect(prompt.direct).toEqual([]);
  expect(JSON.stringify(prompt)).not.toContain("[[");
});

test("the open note's cached briefing lends its description of the link as a headline", () => {
  const root = vault();
  expect(noteRelationInput(root, ada.id, atlas.id).headline).toBeUndefined();
  const file = briefingCacheFile(root, [ada.id], []);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ links: [{ id: atlas.id, description: "is the project she manages" }] }));
  expect(noteRelationInput(root, ada.id, atlas.id).headline).toBe("is the project she manages");
  expect(JSON.parse(noteRelationPrompt(noteRelationInput(root, ada.id, atlas.id))).headline).toBe("is the project she manages");
});

test("one call serves concurrent hovers, is cached, and is redone when the evidence changes", async () => {
  const root = vault();
  let current: NoteRelationInput = noteRelationInput(root, ada.id, atlas.id), calls = 0;
  const generate = createNoteRelationService(async () => {
    calls++;
    await Bun.sleep(5);
    return { model: "test-quick", text: JSON.stringify({ tie: 1, relation: "project Ada manages." }) };
  }, () => current);
  const [a, b] = await Promise.all([generate(root, ada.id, atlas.id), generate(root, ada.id, atlas.id)]);
  expect(a.text).toBe("project Ada manages."); expect(b).toEqual(a); expect(calls).toBe(1);
  await generate(root, ada.id, atlas.id); expect(calls).toBe(1);
  current = { ...current, direct: ["Ada manages Atlas and its budget."] };
  await generate(root, ada.id, atlas.id); expect(calls).toBe(2);
});

test("relations are plain text of gloss length", () => {
  expect(parseNoteRelation('```json\n{"tie":1,"relation":" project Ada manages. "}\n```')).toBe("project Ada manages.");
  for (const bad of ['{"tie":1}', '{"relation":"see [[Atlas]]"}', '{"relation":"see https://example.com"}', `{"relation":"${"word ".repeat(60)}"}`, "not json"])
    expect(() => parseNoteRelation(bad)).toThrow();
});
