import { describe, expect, test } from "bun:test";
import type { AssertionEvent } from "../lib/assertionLog";
import { assertionEntityId } from "../lib/assertionLog";
import { entityAliasResolution } from "../lib/entityAliasLog";
import { authorName, authorOf, buildEntityFeed, buildSquad, firstRecordedAt, plainText, type ChainLink, type SquadSource } from "../lib/squadGraph";

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
const source = (rows: AssertionEvent[], aliases = noAliases, firstAt = new Map<string, string>()): SquadSource => ({ rows, aliases, firstAt });
const day = (d: number, h = 12) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("squad feed", () => {
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
    const squad = buildSquad(source([
      row({ kind: "model", id: "codex" }, "bigbrain-mcp", [atlas], day(2)),
      row({ kind: "model", id: "pi" }, "bigbrain-mcp", [ada], day(3)),
      row({ kind: "model", id: "codex" }, "bigbrain-mcp", [orrery], day(4)),
      row({ kind: "user", id: "robin" }, "note", [ada], day(5)),
    ]));
    expect(squad.authors).toEqual([
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
    const squad = buildSquad(source(rows, aliases));
    expect(squad.feed).toHaveLength(60);
    expect(squad.feed.map((r) => r.at)).toEqual(squad.feed.map((r) => r.at).toSorted());
    const only = buildSquad(source(rows.slice(0, 1), aliases)).feed[0]!;
    expect(only).toMatchObject({ author: "pi", text: "Met Ada about the orrery.", entities: [ada.id] });
  });

  test("a row names its model only when the record does", () => {
    const [own, client] = buildSquad(source([
      row({ kind: "model", id: "model-a", invocation_id: "run-1" }, "intake-assertion-agent", [ada], day(1)),
      row({ kind: "model", id: "pi", invocation_id: "mcp" }, "bigbrain-mcp", [ada], day(2)),
    ])).feed;
    expect(own).toMatchObject({ author: "gardener", by: "model-a", model: true });
    expect(client).toMatchObject({ author: "pi", by: "pi", model: false });
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
    expect(buildSquad(src).feed.map((r) => [r.at, r.writtenAt])).toEqual([[day(3), day(25)], [day(10), undefined]]);
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
