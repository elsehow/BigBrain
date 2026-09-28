/** Synthetic note benchmark fixture. Prints its disposable root and note paths.
 * bun test/support/profileNoteFixture.ts [assertions=2000] */
import { nativeVault, insertion } from "./vault";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from "../../lib/assertionLog";
import { assertionEntityPath, assertionEntityView } from "../../lib/assertionEntityView";
import { noteBriefingInput, briefingPrompt } from "../../lib/noteBriefing";
const count = Number(process.argv[2] ?? 2000);
if (!Number.isInteger(count) || count < 100 || count > 10000) throw new Error("Choose 100–10000 assertions.");
const source = insertion({ title: "Synthetic planning record", body: "Atlas coordinates fictional community projects.", received_at: "2026-09-01T12:00:00.000Z" });
const root = nativeVault({ prefix: "bb-note-profile-", insertions: [source], files: {
  "memory/MEMORY.md": "# Synthetic memory\nAtlas coordinates fictional community projects.\n",
} });
const entities = Array.from({ length: 101 }, (_, i) => ({ id: assertionEntityId(`Synthetic project ${i}`), label: `Synthetic project ${i}` }));
const byId = new Map([[source.id, source]]);
for (let i = 0; i < count; i++) {
  const focus = entities[0]!, other = entities[1 + i % 100]!;
  appendAssertionEvent(root, createAssertionEvent({ text: `[[${focus.id}|${focus.label}]] coordinates milestone ${i} with [[${other.id}|${other.label}]]; the team will review progress at the next planning meeting.`,
    entities: [focus, other], sources: [source.id], author: { kind: "model", id: "fixture", invocation_id: `fixture-${i}` }, confidence: "direct",
    created_at: new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString(), produced_by: { procedure: "benchmark", version: "1" } }, byId));
}
const paths = [0, 1, 2].map(i => assertionEntityPath(entities[i]!.id));
const samples: unknown[] = [];
for (let run = 0; run < 6; run++) {
  const started = performance.now();
  const entity = assertionEntityView(root, paths[0]!);
  const entityMs = performance.now() - started;
  const input = noteBriefingInput(root, { selected: [paths[0]!], excluded: [] });
  const inputMs = performance.now() - started - entityMs;
  const prompt = briefingPrompt(input);
  samples.push({ run, entityMs, inputMs, totalMs: performance.now() - started, assertions: entity?.assertions.length, links: input.links.length, promptCharacters: prompt.prompt.length });
}
console.log(JSON.stringify({ root, paths, assertions: count, entities: entities.length, samples }));
