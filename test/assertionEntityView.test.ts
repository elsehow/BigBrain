/**
 * assertionEntityView — the projected entity page's structured view. The
 * `you` flag (#501): decided by the identity record (the latest owner
 * declaration), never by legacy dossier frontmatter, which projected pages
 * don't carry.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertionEntityPath,
  assertionEntityView,
  assertionsFromSource,
  filterEntityView,
  projectedEntityToc,
  type ProjectedEntityView,
} from "../lib/assertionEntityView";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { appendEntityAliasEvent, createEntityAliasEvent } from "../lib/entityAliasLog";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { declareOwner } from "./support/identity";
import { insertion } from "./support/vault";

describe("the you flag (#501)", () => {
  test("the identity record's entity wears it; every other entity does not", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-entview-"));
    const ins = insertion({
      id: "ins_entview000000000000000a",
      source_id: "src-entview-a",
      author: { kind: "service", id: "test" },
      title: "A note",
      body: "Ada and the owner talked.",
      envelope: { id: "src-entview-a" },
      received_at: "2026-08-20T10:00:00.000Z",
      content_sha256: "sha-entview-a",
    });
    appendSourceInsertionEvent(root, ins);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAssertionEvent(
      root,
      createAssertionEvent(
        {
          text: `[[${ada.id}|Ada Lovelace]] spoke with the owner.`,
          entities: [ada],
          sources: [ins.id],
          author: { kind: "model", id: "test", invocation_id: "run-1" },
          confidence: "direct",
          created_at: "2026-08-20T11:00:00.000Z",
          produced_by: { procedure: "test", version: "v1" },
        },
        new Map([[ins.id, ins]])
      )
    );
    const decl = declareOwner(root, {
      account: "acct_1",
      name: "Alex Rowan",
      verified_email: "alex@example.com",
    });
    const own = assertionEntityView(root, assertionEntityPath(decl.entity_id));
    expect(own?.you).toBe(true);
    expect(own?.label).toBe("Alex Rowan");
    const other = assertionEntityView(root, assertionEntityPath(ada.id));
    expect(other).toBeDefined();
    expect(other?.you).toBeUndefined();
  });
});

describe("filterEntityView — the reader's window over a dossier", () => {
  const row = (id: string, text: string, created_at: string): ProjectedEntityView["assertions"][number] => ({
    id, text, created_at, confidence: "direct", author: { kind: "model", id: "t", invocation_id: "r" }, sources: [],
  });
  const view: ProjectedEntityView = {
    id: "ent_00000000000000000001",
    label: "BigBrain",
    assertions: [
      row("a1", "First: pricing was set at $4.", "2026-08-12T10:00:00.000Z"),
      row("a2", "Second: deploys from one main branch.", "2026-08-20T10:00:00.000Z"),
      row("a3", "Third: [[ent_00000000000000000002|BigBrain Pro]] pricing is trigger-gated.", "2026-08-26T10:00:00.000Z"),
    ],
  };
  const ids = (v: ProjectedEntityView) => v.assertions.map((a) => a.id);

  test("no window is the whole record, in log order, with no total", () => {
    const v = filterEntityView(view, {});
    expect(ids(v)).toEqual(["a1", "a2", "a3"]);
    expect(v.total).toBeUndefined();
  });

  test("q keeps the assertions containing every term — links reduced to their labels", () => {
    expect(ids(filterEntityView(view, { q: "pricing" }))).toEqual(["a1", "a3"]);
    expect(ids(filterEntityView(view, { q: "bigbrain pro" }))).toEqual(["a3"]);
    expect(ids(filterEntityView(view, { q: "PRICING gated" }))).toEqual(["a3"]);
    const none = filterEntityView(view, { q: "kubernetes" });
    expect(ids(none)).toEqual([]);
    expect(none.total).toBe(3);
  });

  test("after/before bound the day written; n keeps the newest; order=desc flips display", () => {
    expect(ids(filterEntityView(view, { after: "2026-08-20" }))).toEqual(["a2", "a3"]);
    expect(ids(filterEntityView(view, { before: "2026-08-20" }))).toEqual(["a1", "a2"]);
    expect(ids(filterEntityView(view, { n: 2 }))).toEqual(["a2", "a3"]);
    expect(ids(filterEntityView(view, { n: 2, order: "desc" }))).toEqual(["a3", "a2"]);
    expect(ids(filterEntityView(view, { q: "pricing", n: 1 }))).toEqual(["a3"]);
    const desc = filterEntityView(view, { order: "desc" });
    expect(ids(desc)).toEqual(["a3", "a2", "a1"]);
    expect(desc.total).toBeUndefined();
  });
});

describe("projectedEntityToc — the dossier's map, not its head and tail", () => {
  const row = (id: string, text: string, created_at: string): ProjectedEntityView["assertions"][number] => ({
    id, text, created_at, confidence: "direct", author: { kind: "model", id: "t", invocation_id: "r" }, sources: [],
  });
  /** A busy entity: 40 assertions over three months, the shape that makes a
   * head-and-tail elision a lottery over which ones the reader sees. */
  const busy: ProjectedEntityView = {
    id: "ent_00000000000000000001",
    label: "BigBrain",
    assertions: [
      ...Array.from({ length: 20 }, (_, i) =>
        row(`j${i}`, `June ${i}: the queue is a view.`, `2026-06-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`)),
      ...Array.from({ length: 15 }, (_, i) =>
        row(`l${i}`, `July ${i}: pricing was reopened.`, `2026-07-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`)),
      ...Array.from({ length: 5 }, (_, i) =>
        row(`a${i}`, `August ${i}: deploys from one main branch.`, `2026-08-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`)),
    ],
  };

  test("month buckets, newest first, each carrying the window that fetches it", () => {
    const toc = projectedEntityToc(busy);
    expect(toc).toContain("# BigBrain");
    expect(toc).toContain("Table of contents: 40 assertions, 2026-06-01 → 2026-08-05");
    expect(toc).toContain("## 2026-08 — 5 assertions (2026-08-01 → 2026-08-05)");
    expect(toc).toContain("## 2026-07 — 15 assertions (2026-07-01 → 2026-07-15)");
    expect(toc).toContain("## 2026-06 — 20 assertions (2026-06-01 → 2026-06-20)");
    // The handle IS the window: paste it back into the same door.
    expect(toc).toContain("`after=2026-08-01 before=2026-08-05`");
    expect(toc.indexOf("## 2026-08")).toBeLessThan(toc.indexOf("## 2026-06"));
    // Every assertion is accounted for by a count; none of them by accident
    // of where it sits in the log.
    expect(toc).toContain("June 0:");
    expect(toc).toContain("June 19:");
    expect(toc).toContain("August 4:");
    // …and the whole map is a fraction of the dossier it maps.
    expect(toc.length).toBeLessThan(2000);
  });

  test("three samples per bucket — first, middle, last", () => {
    const june = projectedEntityToc(busy).split("## 2026-06")[1] ?? "";
    expect(june.split("\n").filter((l) => l.startsWith("- ")).length).toBe(3);
    expect(june).toContain("June 10:");
  });

  test("a dossier inside one month buckets by DAY instead", () => {
    const oneMonth: ProjectedEntityView = { ...busy, assertions: busy.assertions.slice(-5) };
    const toc = projectedEntityToc(oneMonth);
    expect(toc).toContain("## 2026-08-05 — 1 assertion (2026-08-05)");
    expect(toc).toContain("`after=2026-08-05 before=2026-08-05`");
  });

  test("it maps what the window left, and says so", () => {
    const toc = projectedEntityToc(filterEntityView(busy, { q: "pricing" }));
    expect(toc).toContain("Table of contents: 15 of 40 assertions");
    expect(toc).not.toContain("## 2026-06");
  });

  test("order=desc does not scramble the map — buckets are always newest first", () => {
    expect(projectedEntityToc(filterEntityView(busy, { order: "desc" })))
      .toBe(projectedEntityToc(filterEntityView(busy, {})));
  });

  test("an empty window is a TOC that says the record was not empty", () => {
    const toc = projectedEntityToc(filterEntityView(busy, { q: "kubernetes" }));
    expect(toc).toContain("no assertions of 40 match this window");
  });

  test("a link shows as its label, and a long assertion is clipped", () => {
    const long: ProjectedEntityView = {
      ...busy,
      assertions: [row("x", `[[ent_00000000000000000002|BigBrain Pro]] ${"went on and on ".repeat(20)}`, "2026-08-01T10:00:00.000Z")],
    };
    const toc = projectedEntityToc(long);
    expect(toc).toContain("- BigBrain Pro went on");
    expect(toc).not.toContain("ent_00000000000000000002");
    expect(toc).toContain("…");
  });
});

describe("assertionsFromSource — the source note's rail", () => {
  const model = { kind: "model", id: "test", invocation_id: "run-1" } as const;
  const produced_by = { procedure: "test", version: "v1" };

  test("the rows citing one insertion, in log order, wearing their entities as dossier links", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-srcrail-"));
    const a = insertion({
      id: "ins_5a1e0000000000000000000a", source_id: "src-rail-a", title: "Standup",
      received_at: "2026-08-20T10:00:00.000Z", content_sha256: "sha-rail-a",
    });
    const b = insertion({
      id: "ins_5a1e0000000000000000000b", source_id: "src-rail-b", title: "Planning",
      received_at: "2026-08-20T10:30:00.000Z", content_sha256: "sha-rail-b",
    });
    appendSourceInsertionEvent(root, a);
    appendSourceInsertionEvent(root, b);
    const sources = new Map([[a.id, a], [b.id, b]]);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    const atlas = { id: assertionEntityId("Atlas"), label: "Atlas" };
    const assert = (text: string, entities: typeof ada[], cites: string[], created_at: string) =>
      appendAssertionEvent(root, createAssertionEvent(
        { text, entities, sources: cites, author: model, confidence: "direct", created_at, produced_by },
        sources,
      ));
    assert(`[[${ada.id}|Ada]] runs [[${atlas.id}|Atlas]].`, [ada, atlas], [a.id], "2026-08-20T11:00:00.000Z");
    assert(`[[${atlas.id}|Atlas]] ships Friday.`, [atlas], [a.id, b.id], "2026-08-20T12:00:00.000Z");
    assert(`[[${ada.id}|Ada]] is away next week.`, [ada], [b.id], "2026-08-20T13:00:00.000Z");

    const rows = assertionsFromSource(root, a.id);
    expect(rows.map((r) => r.text)).toEqual([
      `[[${assertionEntityPath(ada.id)}|Ada]] runs [[${assertionEntityPath(atlas.id)}|Atlas]].`,
      `[[${assertionEntityPath(atlas.id)}|Atlas]] ships Friday.`,
    ]);
    expect(rows[0]!.entities).toEqual([
      { id: ada.id, label: "Ada Lovelace", path: assertionEntityPath(ada.id) },
      { id: atlas.id, label: "Atlas", path: assertionEntityPath(atlas.id) },
    ]);
    expect(rows[1]!.entities).toEqual([{ id: atlas.id, label: "Atlas", path: assertionEntityPath(atlas.id) }]);
    expect(rows.map((r) => r.created_at)).toEqual(["2026-08-20T11:00:00.000Z", "2026-08-20T12:00:00.000Z"]);
    // the other source sees its own two; a source nothing cites is empty, not absent
    expect(assertionsFromSource(root, b.id).map((r) => r.text.slice(-13))).toEqual(["ships Friday.", "ay next week."]);
    expect(assertionsFromSource(root, "ins_5a1e0000000000000000000c")).toEqual([]);
  });

  test("a stub the alias log folds in wears the canonical dossier, once, under the canonical label", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-srcrail-alias-"));
    const src = insertion({
      id: "ins_5a1e0000000000000000001a", source_id: "src-rail-alias", title: "Notes",
      received_at: "2026-08-21T10:00:00.000Z", content_sha256: "sha-rail-alias",
    });
    appendSourceInsertionEvent(root, src);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    const stub = { id: assertionEntityId("Ada"), label: "Ada" };
    appendEntityAliasEvent(root, createEntityAliasEvent({
      alias: "Ada", entity: ada, author: { kind: "user", id: "acct_1" },
      created_at: "2026-08-21T09:00:00.000Z", produced_by,
    }));
    appendAssertionEvent(root, createAssertionEvent(
      {
        text: `[[${stub.id}|Ada]] met [[${ada.id}|Ada Lovelace]] — the same person twice.`,
        entities: [stub, ada], sources: [src.id], author: model, confidence: "candidate",
        created_at: "2026-08-21T11:00:00.000Z", produced_by,
      },
      new Map([[src.id, src]]),
    ));
    const [row] = assertionsFromSource(root, src.id);
    expect(row!.entities).toEqual([{ id: ada.id, label: "Ada Lovelace", path: assertionEntityPath(ada.id) }]);
    expect(row!.text).toBe(
      `[[${assertionEntityPath(ada.id)}|Ada]] met [[${assertionEntityPath(ada.id)}|Ada Lovelace]] — the same person twice.`,
    );
    expect(row!.confidence).toBe("candidate");
  });
});
