import { describe, expect, test } from "bun:test";
import type { AssertionEvent } from "../lib/assertionLog";
import { assertionEntityId } from "../lib/assertionLog";
import { entityAliasResolution } from "../lib/entityAliasLog";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorName, authorOf, buildEntityFeed, buildSortedFeed, buildV2Feed, firstRecordedAt, plainText, type ChainLink, type V2Source } from "../lib/v2Feed";
import { gardenerModels } from "../lib/v2Read";

const ent = (label: string) => ({ id: assertionEntityId(label), label });
const ada = ent("Ada Lovelace"), atlas = ent("Atlas"), orrery = ent("Orrery");
let n = 0;
const row = (author: AssertionEvent["author"], procedure: string, entities: Array<{ id: string; label: string }>, at: string, text?: string): AssertionEvent => ({
  event: "assertion.asserted",
  id: `ast_${String(++n).padStart(4, "0")}`,
  text: text ?? entities.map((e) => `[[${e.id}|${e.label}]]`).join(" and ") + " came up.",
  entities,
  author,
  confidence: "direct",
  created_at: at,
  produced_by: { procedure, version: "v1" },
});
const noAliases = entityAliasResolution([]);
const source = (rows: AssertionEvent[], aliases = noAliases, firstAt = new Map<string, string>()): V2Source => ({ rows, aliases, firstAt });
const day = (d: number, h = 12) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("v2 feed", () => {
  test("authors are model and agent authors; the vault's own passes are one gardener", () => {
    expect(authorOf(row({ kind: "model", id: "model-a" }, "intake-assertion-agent", [], day(1)))).toBe("gardener");
    expect(authorOf(row({ kind: "model", id: "model-b" }, "other-assertion-agent", [], day(1)))).toBe("gardener");
    expect(authorOf(row({ kind: "model", id: "claude-code" }, "bigbrain-mcp", [], day(1)))).toBe("claude-code");
    expect(authorOf(row({ kind: "agent", id: "tidy-up" }, "review", [], day(1)))).toBe("tidy-up");
    expect(authorOf(row({ kind: "user", id: "robin" }, "bootstrap", [], day(1)))).toBeNull();
    expect(authorOf(row({ kind: "system", id: "entity-supersede" }, "entity-supersede", [], day(1)))).toBeNull();
    expect(authorName("claude-code")).toBe("Claude Code");
    expect(authorName("tidy-up")).toBe("Tidy up");
  });

  test("authors carry only what the record says: count and last write, most recent first", () => {
    const out = buildV2Feed(source([
      row({ kind: "model", id: "codex" }, "bigbrain-mcp", [atlas], day(2)),
      row({ kind: "model", id: "pi" }, "bigbrain-mcp", [ada], day(3)),
      row({ kind: "model", id: "codex" }, "bigbrain-mcp", [orrery], day(4)),
      row({ kind: "user", id: "robin" }, "note", [ada], day(5)),
    ]));
    expect(out.authors).toEqual([
      { id: "codex", name: "Codex", count: 2, lastAt: day(4) },
      { id: "pi", name: "Pi", count: 1, lastAt: day(3) },
    ]);
  });

  test("the feed is the latest rows, oldest first, plain prose, entities folded through aliases", () => {
    const short = { id: assertionEntityId("Ada"), label: "Ada" };
    const aliases = entityAliasResolution([{
      event: "entity.aliased", id: "ali_0001", alias: "Ada", alias_id: short.id, entity: ada,
      author: { kind: "user", id: "robin" }, created_at: day(1), produced_by: { procedure: "fold", version: "v1" },
    }]);
    const rows = [row({ kind: "model", id: "pi" }, "bigbrain-mcp", [short, ada], day(1), `Met [[${short.id}|Ada]] about the orrery.`)];
    for (let i = 0; i < 70; i++) rows.push(row({ kind: "model", id: "codex" }, "bigbrain-mcp", [atlas], day(10, i % 24)));
    const out = buildV2Feed(source(rows, aliases));
    expect(out.feed).toHaveLength(60);
    expect(out.feed.map((r) => r.at)).toEqual(out.feed.map((r) => r.at).toSorted());
    const only = buildV2Feed(source(rows.slice(0, 1), aliases)).feed[0]!;
    expect(only).toMatchObject({ author: "pi", text: "Met Ada about the orrery.", entities: [ada.id] });
  });

  test("a row names its model only when the record does", () => {
    const [own, client] = buildV2Feed(source([
      row({ kind: "model", id: "model-a", invocation_id: "run-1" }, "intake-assertion-agent", [ada], day(1)),
      row({ kind: "model", id: "pi", invocation_id: "mcp" }, "bigbrain-mcp", [ada], day(2)),
    ])).feed;
    expect(own).toMatchObject({ author: "gardener", by: "model-a", model: true });
    expect(client).toMatchObject({ author: "pi", by: "pi", model: false });
  });

  test("the gardener writing through its agent is named by the model its run journal names", () => {
    const filed = row({ kind: "model", id: "pi", invocation_id: "mcp" }, "bigbrain-mcp", [ada], day(2));
    const client = row({ kind: "model", id: "pi", invocation_id: "mcp" }, "bigbrain-mcp", [atlas], day(3));
    const out = buildV2Feed({ ...source([filed, client]), models: new Map([[filed.id, "model-z"]]) });
    expect(out.feed).toMatchObject([{ author: "gardener", by: "model-z", model: true }, { author: "pi", by: "pi", model: false }]);
    expect(out.authors.map((a) => [a.id, a.count])).toEqual([["pi", 1], ["gardener", 1]]);
  });

  test("a gardener row's model is the one its run was on: the run it was written during", () => {
    const root = mkdtempSync(join(tmpdir(), "v2-models-"));
    try {
      const journal = (id: string, model: string, start: string, end: string) => {
        mkdirSync(join(root, "journal/tend", end.slice(0, 7)), { recursive: true });
        writeFileSync(join(root, "journal/tend", end.slice(0, 7), `${id}.json`), JSON.stringify({ format: "bigbrain-tend-run/v1", invocation_id: id, insertion_ids: [], model, started_at: start, completed_at: end }));
      };
      journal("run-a", "model-a", day(2, 10), day(2, 11));
      journal("run-b", "model-b", day(5, 10), day(5, 11));
      const pi = { kind: "model", id: "pi", invocation_id: "mcp" } as const;
      const inA = row(pi, "bigbrain-mcp", [ada], "2026-08-02T10:30:00.000Z");
      const inB = row({ kind: "model", id: "claude", invocation_id: "mcp" }, "bigbrain-mcp", [ada], "2026-08-05T10:59:59.000Z");
      const between = row(pi, "bigbrain-mcp", [ada], day(3));
      const stranger = row({ kind: "model", id: "codex", invocation_id: "mcp" }, "bigbrain-mcp", [ada], "2026-08-02T10:30:00.000Z");
      expect(gardenerModels(root, [inA, inB, between, stranger])).toEqual(new Map([[inA.id, "model-a"], [inB.id, "model-b"]]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a rewrite keeps the date its claim was first recorded", () => {
    const original = row({ kind: "model", id: "codex" }, "bigbrain-mcp", [atlas], day(3));
    const fixed = { ...row({ kind: "agent", id: "provenance-cleanup" }, "cleanup", [atlas], day(21)), supersedes: original.id };
    const again = { ...row({ kind: "agent", id: "provenance-cleanup" }, "cleanup", [atlas], day(25)), supersedes: fixed.id };
    const chain = new Map<string, ChainLink>([original, fixed, again].map((r) => [r.id, { id: r.id, created_at: r.created_at, supersedes: r.supersedes ?? null }]));
    const later = row({ kind: "model", id: "pi" }, "bigbrain-mcp", [atlas], day(10));
    const firstAt = firstRecordedAt([again, later], chain);
    expect(firstAt.get(again.id)).toBe(day(3));
    const src = source([again, later], noAliases, firstAt);
    // the rewrite sorts at its original's date, and says when it was rewritten
    expect(buildV2Feed(src).feed.map((r) => [r.at, r.writtenAt])).toEqual([[day(3), day(25)], [day(10), undefined]]);
    expect(buildEntityFeed(src, atlas.id).map((r) => r.id)).toEqual([again.id, later.id]);
  });

  test("an entity's own feed folds its aliases", () => {
    const short = { id: assertionEntityId("Ada"), label: "Ada" };
    const aliases = entityAliasResolution([{
      event: "entity.aliased", id: "ali_0002", alias: "Ada", alias_id: short.id, entity: ada,
      author: { kind: "user", id: "robin" }, created_at: day(1), produced_by: { procedure: "fold", version: "v1" },
    }]);
    const rows = [row({ kind: "model", id: "pi" }, "bigbrain-mcp", [short], day(2)), row({ kind: "model", id: "pi" }, "bigbrain-mcp", [orrery], day(3))];
    expect(buildEntityFeed(source(rows, aliases), short.id).map((r) => r.at)).toEqual([day(2)]);
  });

  test("plain text reads wikilinks as their labels", () => {
    expect(plainText("Met [[ent_x|Ada]] about [[Atlas]].\n Again.")).toBe("Met Ada about Atlas. Again.");
  });
});

describe("sorted feed", () => {
  const gardener = { kind: "model", id: "model-a" } as const;
  const a = row(gardener, "intake-assertion-agent", [ada], day(3)), b = row(gardener, "intake-assertion-agent", [atlas], day(5));
  const c = row(gardener, "intake-assertion-agent", [orrery], day(4)), d = row(gardener, "intake-assertion-agent", [ada, orrery], day(6));
  const entry = (source: string, section: string, assertions: string[], expires: string | null = null, added = day(10)) =>
    ({ source, section, headline: `About ${source}`, expires, assertions, added });

  test("newest first, the most pressing first within one arrival; joined to the live claims' entities", () => {
    const rows = buildSortedFeed(source([a, b, c, d]), [
      entry("ins_know", "know", [b.id]), entry("ins_old", "needs-you", [a.id], null, day(9)),
      entry("ins_agent", "agent", [c.id], "2026-08-20"), entry("ins_new", "needs-you", [a.id, d.id], null, day(11)),
    ]);
    expect(rows.map((r) => [r.source, r.section, r.added])).toEqual([
      ["ins_new", "needs-you", day(11)], ["ins_agent", "agent", day(10)], ["ins_know", "know", day(10)], ["ins_old", "needs-you", day(9)]]);
    expect(rows[0]!.entities).toEqual([ada.id, orrery.id]);
    expect(rows[1]!.due).toBe("2026-08-20");
  });

  test("an entry whose claims were all revoked since, or that was skipped, is not shown", () => {
    expect(buildSortedFeed(source([a]), [entry("ins_gone", "needs-you", ["ast_revoked"]), entry("ins_skip", "skip", [a.id])])).toEqual([]);
  });
});
