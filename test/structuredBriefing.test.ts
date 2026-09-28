import { rmSync } from "node:fs";
import { nativeVault } from "./support/vault";
import { fakePi } from "./support/pi";
import { runAgent } from "../lib/run/agent";
import { createNoteBriefingService } from "../lib/noteBriefing";
import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { noteBriefingSchema, parseNoteBriefing, type NoteBriefingInput } from "../lib/noteBriefing";

const input: NoteBriefingInput = {
  items: [{ id: "atlas", path: "entities/atlas.md", title: "Atlas", kind: "entity", text: "A tool library." }], excluded: [], relationships: [],
  links: [
    { id: "maya", path: "entities/maya.md", title: "Maya", evidence: [{ text: "Maya coordinates Atlas." }, { text: "Maya recruits its volunteers." }] },
    { id: "leo", path: "entities/leo.md", title: "Leo", evidence: [{ text: "Leo manages the lease." }] },
  ],
};
const valid = { summary: "Atlas is a neighborhood tool library.", links: {
  L1: { description: "coordinates its volunteers", evidence: [2] },
  L2: { description: "manages its lease", evidence: [1] },
} };

test("the provider schema rejects the actual missing-evidence failure and binds indices to each link", () => {
  const schema = noteBriefingSchema(input);
  expect(Check(schema, valid)).toBe(true);
  for (const evidence of [undefined, [], [0], [3], ["1"], [1.5], [1, 1]])
    expect(Check(schema, { ...valid, links: { ...valid.links, L1: { ...valid.links.L1, evidence } } })).toBe(false);
  // Index 2 belongs to L1, not L2; a generic integer schema would accept it.
  expect(Check(schema, { ...valid, links: { ...valid.links, L2: { ...valid.links.L2, evidence: [2] } } })).toBe(false);
  expect(Check(schema, { ...valid, links: { L1: valid.links.L1 } })).toBe(false);
  expect(Check(schema, { ...valid, links: { ...valid.links, L3: valid.links.L1 } })).toBe(false);
  for (const summary of ["", " ", "<script>", "[invented]", "https://example.com", "x".repeat(1201)])
    expect(Check(schema, { ...valid, summary })).toBe(false);
  for (const description of ["", " ", "[invented]", "x".repeat(451)])
    expect(Check(schema, { ...valid, links: { ...valid.links, L1: { ...valid.links.L1, description } } })).toBe(false);
  expect(JSON.stringify(schema)).not.toContain("Maya");
  expect(JSON.stringify(schema)).not.toContain("entities/");
});

test("structured output resolves to ranked links and retains the selected evidence", () => {
  const parsed = parseNoteBriefing(JSON.stringify({ ...valid, links: { L2: valid.links.L2, L1: valid.links.L1 } }), input);
  expect(parsed.links.map(link => link.id)).toEqual(["maya", "leo"]);
  expect(parsed.links[0]!.evidence).toEqual([input.links[0]!.evidence[1]!]);
  const empty = { ...input, links: [] };
  const output = { summary: valid.summary, links: {} };
  expect(Check(noteBriefingSchema(empty), output)).toBe(true);
  expect(parseNoteBriefing(JSON.stringify(output), empty).links).toEqual([]);
});

test("a fenced Pi briefing passes schema validation and is reused on return to the selection", async () => {
  const root = nativeVault({ files: { "vault.yaml": "{}" } });
  let calls = 0;
  try {
    const generate = createNoteBriefingService(async (root, prompt, preview, instructions, options) => {
      const result = await runAgent({ root, role: "quick", auth: "max", target: { adapter: "pi", provider: "anthropic", model: "claude-haiku-4-5" },
        capabilities: "none", prompt, instructions, onText: preview,
        output: { requireText: true, schema: options?.outputSchema }, timeoutMs: 2000 },
      fakePi(() => { calls++; return { result: "```json\n" + JSON.stringify(valid) + "\n```" }; }));
      return { text: result.text, model: "claude-haiku-4-5" };
    }, () => input);
    const first = await generate(root, input.items[0]!.path);
    expect(first.summary).toBe(valid.summary);
    expect(first.links.map(link => link.description)).toEqual([valid.links.L1.description, valid.links.L2.description]);
    expect(await generate(root, input.items[0]!.path)).toEqual(first);
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
