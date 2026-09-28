import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { nativeVault, insertion } from "./support/vault";
import * as projection from "../lib/assertionProjection";
import { submitWire } from "../lib/work";

const opts = { author: { kind: "agent" as const, id: "test" }, produced_by: { procedure: "test", version: "1" } };
test("wire validation shares one inventory per batch and refreshes it for the next submission", () => {
  const source = insertion(), root = nativeVault({ insertions: [source] });
  const inventory = spyOn(projection, "projectedLabelRows");
  const item = (label: string) => ({ submit: "assertion", text: `[[${label}]] was reported.`, sources: [source.id], confidence: "direct" });
  try {
    const batch = submitWire(root, Array.from({ length: 32 }, (_, i) => item(`Fresh discovery ${i + 1000}`)), opts);
    expect(batch.rejected).toBe(0); expect(batch.appended).toBe(32);
    expect(inventory).toHaveBeenCalledTimes(1);
    const next = submitWire(root, [item("Fresh discovry 1000")], opts);
    expect(next.rejected).toBe(1);
    expect(next.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Fresh discovery 1000") });
    expect(inventory).toHaveBeenCalledTimes(2);
    // A batch of already-known labels does not need a lookalike inventory.
    expect(submitWire(root, [item("Fresh discovery 1000")], opts).deduped).toBe(1);
    expect(inventory).toHaveBeenCalledTimes(2);
  } finally { inventory.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
