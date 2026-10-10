import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAssertionEvent,
  assertionEntityId,
  createAssertionEvent,
  type AssertionEvent,
} from "../lib/assertionLog";
import { createEntityAliasEvent } from "../lib/entityAliasLog";
import { createRevocationEvent } from "../lib/revocationLog";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import {
  appendAndProjectEntityAlias,
  appendAndProjectRevocation,
  listAssertions,
  syncAssertionProjection,
  tallyAssertionEntities,
} from "../lib/assertionProjection";
import { insertion } from "./support/vault";

// #686: `search` is a find-X door and requires a term. The SLICE — "every
// assertion since 2026-08-22, newest CONTENT first" — had no door, so every
// memory run rebuilt one over the raw logs, differently each time. These
// pin the window's two hard parts: the date is the sources', and the day
// bounds are inclusive.

afterEach(() => {
  delete process.env["BIGBRAIN_ASSERTION_DB"];
});

const author = { kind: "model", id: "test", invocation_id: "run-1" } as const;
const produced_by = { procedure: "test", version: "v1" } as const;

/** A vault whose assertions were all ASSERTED on one day (as the gardener
 * really does) but whose sources carry content dates years apart. */
function listVault(
  rows: Array<{ n: number; label: string; occurred?: string; text?: string }>
): { root: string; asts: AssertionEvent[] } {
  const root = mkdtempSync(join(tmpdir(), "bb-assertlist-"));
  process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
  const asts: AssertionEvent[] = [];
  for (const r of rows) {
    const pad = String(r.n).padStart(24, "0");
    const src = insertion({
      id: `ins_${pad}`,
      source_id: `src-${r.n}`,
      title: `Source ${r.n}`,
      ...(r.occurred ? { occurred_at: r.occurred } : {}),
      received_at: "2026-08-31T09:00:00.000Z",
      content_sha256: `sha-${r.n}`,
    });
    appendSourceInsertionEvent(root, src);
    const ent = { id: assertionEntityId(r.label), label: r.label };
    const a = createAssertionEvent(
      {
        text: r.text ?? `[[${ent.id}|${r.label}]] did thing ${r.n}.`,
        entities: [ent],
        sources: [src.id],
        author,
        confidence: "direct",
        // Import day, every one of them — the trap the door exists to avoid.
        created_at: "2026-08-31T10:00:00.000Z",
        produced_by,
      },
      new Map([[src.id, src]])
    );
    appendAssertionEvent(root, a);
    asts.push(a);
  }
  // Readers never sync themselves — the door does (bin/assertions.ts), the
  // omnibox does (searchCore). Tests stand in for the door.
  syncAssertionProjection(root);
  return { root, asts };
}

describe("listAssertions", () => {
  test("dates and orders by the SOURCES' content date, not created_at", () => {
    const { root } = listVault([
      { n: 1, label: "Atlas", occurred: "2019-04-02T00:00:00.000Z" },
      { n: 2, label: "Babbage", occurred: "2026-05-11T00:00:00.000Z" },
      { n: 3, label: "Colossus", occurred: "2013-02-20T00:00:00.000Z" },
    ]);
    const rows = listAssertions(root);

    // Every created_at is 2026-08-31; ordering by it would give 1,2,3.
    expect(rows.map((r) => r.date.slice(0, 10))).toEqual(["2026-05-11", "2019-04-02", "2013-02-20"]);
    expect(rows[0]!.entities).toEqual([
      { id: assertionEntityId("Babbage"), label: "Babbage" },
    ]);
  });

  test("falls back to created_at when no source carries a content date", () => {
    const { root } = listVault([{ n: 1, label: "Atlas" }]);
    expect(listAssertions(root)[0]!.date.slice(0, 10)).toBe("2026-08-31");
  });

  test("--since/--until bound the DAY, so a same-day assertion is inside both", () => {
    const { root } = listVault([
      { n: 1, label: "Atlas", occurred: "2026-08-22T23:59:00.000Z" },
      { n: 2, label: "Babbage", occurred: "2026-08-21T23:59:00.000Z" },
      { n: 3, label: "Colossus", occurred: "2026-08-23T00:00:01.000Z" },
    ]);

    const day = listAssertions(root, { since: "2026-08-22", until: "2026-08-22" });
    expect(day.map((r) => r.entities[0]!.label)).toEqual(["Atlas"]);
    expect(listAssertions(root, { since: "2026-08-22" }).length).toBe(2);
    expect(listAssertions(root, { until: "2026-08-22" }).length).toBe(2);
  });

  test("--entity answers for an alias id, not only the canonical one", () => {
    const { root } = listVault([
      { n: 1, label: "Field Research Institute", occurred: "2026-08-10T00:00:00.000Z" },
      { n: 2, label: "Babbage", occurred: "2026-08-10T00:00:00.000Z" },
    ]);
    const canonical = {
      id: assertionEntityId("Field Research Institute"),
      label: "Field Research Institute",
    };
    appendAndProjectEntityAlias(
      root,
      createEntityAliasEvent({
        alias: "FRI",
        entity: canonical,
        author,
        created_at: "2026-08-31T10:00:00.000Z",
        produced_by,
      })
    );
    syncAssertionProjection(root);

    const viaAlias = listAssertions(root, { entity: assertionEntityId("FRI") });
    expect(viaAlias.map((r) => r.entities[0]!.label)).toEqual(["Field Research Institute"]);
    expect(listAssertions(root, { entity: canonical.id }).length).toBe(1);
  });

  test("a revoked assertion is not in the window", () => {
    const { root, asts } = listVault([
      { n: 1, label: "Atlas", occurred: "2026-08-10T00:00:00.000Z" },
      { n: 2, label: "Babbage", occurred: "2026-08-11T00:00:00.000Z" },
    ]);
    appendAndProjectRevocation(
      root,
      createRevocationEvent({
        assertion_id: asts[0]!.id,
        reason: "wrong",
        author,
        created_at: "2026-08-31T11:00:00.000Z",
        produced_by,
      })
    );
    syncAssertionProjection(root);
    expect(listAssertions(root).map((r) => r.entities[0]!.label)).toEqual(["Babbage"]);
  });

  test("no limit means the whole window; a limit bounds it", () => {
    const { root } = listVault(
      Array.from({ length: 5 }, (_, i) => ({
        n: i + 1,
        label: `E${i}`,
        occurred: `2026-08-1${i}T00:00:00.000Z`,
      }))
    );
    expect(listAssertions(root).length).toBe(5);
    expect(listAssertions(root, { limit: 0 }).length).toBe(5);
    expect(listAssertions(root, { limit: 2 }).length).toBe(2);
  });
});

describe("tallyAssertionEntities", () => {
  test("counts live assertions per entity over their content span, most-cited first", () => {
    const { root, asts } = listVault([
      { n: 1, label: "Atlas", occurred: "2019-04-02T00:00:00.000Z" },
      { n: 2, label: "Atlas", occurred: "2026-05-11T00:00:00.000Z" },
      { n: 3, label: "Atlas", occurred: "2026-08-01T00:00:00.000Z" },
      { n: 4, label: "Babbage", occurred: "2026-06-01T00:00:00.000Z" },
    ]);
    appendAndProjectRevocation(
      root,
      createRevocationEvent({
        assertion_id: asts[2]!.id,
        reason: "wrong",
        author,
        created_at: "2026-08-31T11:00:00.000Z",
        produced_by,
      })
    );
    syncAssertionProjection(root);

    const tally = tallyAssertionEntities(root);
    expect(tally).toEqual([
      {
        id: assertionEntityId("Atlas"),
        label: "Atlas",
        assertions: 2, // the revoked third is gone
        first: "2019-04",
        last: "2026-05",
      },
      {
        id: assertionEntityId("Babbage"),
        label: "Babbage",
        assertions: 1,
        first: "2026-06",
        last: "2026-06",
      },
    ]);
  });
});
