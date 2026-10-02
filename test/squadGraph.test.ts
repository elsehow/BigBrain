import { describe, expect, test } from "bun:test";
import type { AssertionEvent } from "../lib/assertionLog";
import { assertionEntityId } from "../lib/assertionLog";
import { entityAliasResolution } from "../lib/entityAliasLog";
import { agentName, agentOf, buildSquad, plainText } from "../lib/squadGraph";

const ent = (label: string) => ({ id: assertionEntityId(label), label });
const ada = ent("Ada Lovelace"), atlas = ent("Atlas"), orrery = ent("Orrery"), you = ent("Robin Vale");
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
const day = (d: number, h = 12) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("squad graph", () => {
  test("agents are model and agent authors; the vault's own passes are one gardener", () => {
    expect(agentOf(row({ kind: "model", id: "model-a" }, "intake-assertion-agent", [], day(1)))).toBe("gardener");
    expect(agentOf(row({ kind: "model", id: "model-b" }, "other-assertion-agent", [], day(1)))).toBe("gardener");
    expect(agentOf(row({ kind: "model", id: "claude-code" }, "bigbrain-mcp", [], day(1)))).toBe("claude-code");
    expect(agentOf(row({ kind: "agent", id: "tidy-up" }, "review", [], day(1)))).toBe("tidy-up");
    expect(agentOf(row({ kind: "user", id: "robin" }, "bootstrap", [], day(1)))).toBeNull();
    expect(agentOf(row({ kind: "system", id: "entity-supersede" }, "entity-supersede", [], day(1)))).toBeNull();
    expect(agentName("claude-code")).toBe("Claude Code");
    expect(agentName("tidy-up")).toBe("Tidy up");
  });

  test("an agent's task is what its recent work centres on, leaving out hubs", () => {
    const rows: AssertionEvent[] = [];
    // the owner is in nearly everything: a hub, never a task
    for (let i = 0; i < 30; i++) rows.push(row({ kind: "model", id: "codex" }, "bigbrain-mcp", [you, i % 3 ? atlas : ada], day(2, i % 24)));
    rows.push(row({ kind: "model", id: "codex" }, "bigbrain-mcp", [you, orrery], day(3), `[[${orrery.id}|The orrery]] was rebuilt.`));
    const squad = buildSquad(rows, noAliases);
    expect(squad.agents.map((a) => a.id)).toEqual(["codex"]);
    const codex = squad.agents[0]!;
    expect(codex.count).toBe(31);
    expect(codex.task).toEqual({ id: atlas.id, label: "Atlas" });
    expect(codex.touch).toEqual([atlas.id, ada.id, orrery.id]);
    expect(codex.say[orrery.id]).toBe("The orrery was rebuilt.");
  });

  test("aliases fold an entity's names into one before anything is counted", () => {
    const short = { id: assertionEntityId("Ada"), label: "Ada" };
    const aliases = entityAliasResolution([{
      event: "entity.aliased", id: "ali_0001", alias: "Ada", alias_id: short.id, entity: ada,
      author: { kind: "user", id: "robin" }, created_at: day(1), produced_by: { procedure: "fold", version: "v1" },
    }]);
    const squad = buildSquad([
      row({ kind: "model", id: "pi" }, "bigbrain-mcp", [short], day(4)),
      row({ kind: "model", id: "pi" }, "bigbrain-mcp", [ada], day(5)),
    ], aliases);
    expect(squad.agents[0]!.touch).toEqual([ada.id]);
    expect(squad.feed.map((r) => r.entities)).toEqual([[ada.id], [ada.id]]);
  });

  test("the feed is oldest first, plain prose, and keeps each agent's own latest", () => {
    const rows = [row({ kind: "model", id: "quiet" }, "bigbrain-mcp", [orrery], day(1), `Checked [[${orrery.id}|Orrery]] gears.`)];
    for (let i = 0; i < 50; i++) rows.push(row({ kind: "model", id: "busy" }, "bigbrain-mcp", [atlas], day(10, i % 24)));
    rows.push(row({ kind: "user", id: "robin" }, "note", [ada], day(20)));
    const squad = buildSquad(rows, noAliases);
    expect(squad.agents.map((a) => a.id)).toEqual(["busy", "quiet"]);
    expect(squad.feed[0]).toMatchObject({ agent: "quiet", text: "Checked Orrery gears." });
    expect(squad.feed.at(-1)).toMatchObject({ agent: null, entities: [ada.id] });
    expect(squad.feed.map((r) => r.at)).toEqual(squad.feed.map((r) => r.at).toSorted());
  });

  test("plain text reads wikilinks as their labels", () => {
    expect(plainText("Met [[ent_x|Ada]] about [[Atlas]].\n Again.")).toBe("Met Ada about Atlas. Again.");
  });
});
