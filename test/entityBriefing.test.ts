import { describe, expect, test } from "bun:test";
import { briefingEvidence } from "../lib/entityBriefing";
import type { ProjectedEntityAssertion, ProjectedEntityView } from "../lib/assertionEntityView";

const row = (n: number, text = `A fact about Atlas, number ${n}.`): ProjectedEntityAssertion => ({
  id: `ast_${String(n).padStart(24, "0")}`, text, confidence: "direct", author: { kind: "service", id: "test" },
  created_at: new Date(Date.UTC(2026, 0, n + 1)).toISOString(),
  sources: [{ insertion_id: `ins_${String(n).padStart(24, "0")}`, source_id: `source-${n}`,
    path: `log/insertions/2026-01/ins_${String(n).padStart(24, "0")}.json`, title: `Source ${n}`, band: "person", from: "test" }],
});
const view = (rows = [row(1)]): ProjectedEntityView => ({ id: "ent_00000000000000000001", label: "Atlas", assertions: rows });

describe("entity briefings", () => {
  test("bounded evidence retains background and recent facts, with their conflicting text intact", () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i, `${i === 0 ? "Planned to launch in June." : i === 299 ? "The June launch was canceled." : "Background."} ${"Context. ".repeat(30)}`));
    const evidence = briefingEvidence(view(rows));
    expect(evidence[0]!.text).toContain("Planned to launch");
    expect(evidence.at(-1)!.text).toContain("was canceled");
    expect(evidence.reduce((n, a) => n + JSON.stringify(a).length, 0)).toBeLessThanOrEqual(24_000);
    expect(evidence.length).toBeLessThanOrEqual(80);
    expect(new Set(evidence.map(a => a.id)).size).toBe(evidence.length);
    expect(briefingEvidence(view([row(1), { ...row(2), sources: [] }]))).toEqual([row(1)]);
  });

});
