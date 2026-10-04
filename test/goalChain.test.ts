import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { chainHasWork } from "../lib/chain";
import { CHAINS } from "../lib/chains";
import { goalChain, latestPicture, pictureRecords, renderGoalSource, runGoals } from "../lib/goalChain";
import { readGoalLog } from "../lib/goalLog";
import type { SourceInsertion } from "../lib/insertionLog";
import { loadManifest } from "../lib/manifest";
import { acquire, release } from "../lib/pidLock";
import type { ModelRunRequest } from "../lib/run/request";
import { dueIntakeIds } from "../lib/work";
import { insertionSeq, nativeVault, NATIVE_YAML } from "./support/vault";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const insertion = insertionSeq();

const GOALS_YAML = (extra = "") => `${NATIVE_YAML}chains:
  goals:
    goals:
      - "Grow tomatoes. Patience, soil, sun."
      - "Learn the cello."
    since: 2026-08-01
${extra}`;

const vault = (yaml: string, ...insertions: SourceInsertion[]): string => {
  const root = nativeVault({ prefix: "bb-goals-", insertions, files: { "vault.yaml": yaml } });
  scratch.push(root);
  return root;
};

/** A scripted model: source calls (which ask for the schema) answer one
 * about_goals assertion per arrival, picture calls answer a numbered picture.
 * Every request is kept so a test can read what each call was shown. */
function scripted(answer: (title: string) => unknown[] = (t) => [{ type: "about_goals", assertion: `said ${t}`, relevance: `RELEVANCE-${t}` }]) {
  const calls: ModelRunRequest[] = [];
  let pictures = 0;
  const runner = async (req: ModelRunRequest) => {
    calls.push(req);
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, cost_usd: 0.01 };
    if (req.output?.schema) {
      const title = /title: (.*)/.exec(req.prompt)![1]!;
      return { text: JSON.stringify({ assertions: answer(title) }), sessionId: "s", wallMs: 1, usage };
    }
    return { text: `PICTURE v${++pictures}`, sessionId: "s", wallMs: 1, usage };
  };
  return { runner, calls, sources: () => calls.filter((c) => c.output?.schema), pictures: () => calls.filter((c) => !c.output?.schema) };
}

const at = (date: string) => insertion({ received_at: `${date}T12:00:00.000Z`, occurred_at: `${date}T12:00:00.000Z`, title: `item-${date}` });
const now = () => new Date("2026-08-25T00:00:00.000Z");

describe("vault.yaml chains.goals", () => {
  test("defaults: Sonnet at medium effort per source, Opus for the picture, weekly, 4 at once, 100 a run", () => {
    const cfg = loadManifest(vault(GOALS_YAML())).chains.goals!;
    expect(cfg.goals).toEqual(["Grow tomatoes. Patience, soil, sun.", "Learn the cello."]);
    expect(cfg.source).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", reasoning: "medium" });
    expect(cfg.picture).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
    expect([cfg.interval, cfg.intervalMs, cfg.concurrency, cfg.batch]).toEqual(["7d", 7 * 86_400_000, 4, 100]);
  });

  test("absent is off; a malformed block names its fix", () => {
    expect(loadManifest(vault(NATIVE_YAML)).chains).toEqual({});
    expect(() => loadManifest(vault(`${NATIVE_YAML}chains:\n  goals:\n    since: 2026-08-01\n`))).toThrow(/list of goals/);
    expect(() => loadManifest(vault(`${NATIVE_YAML}chains:\n  goals:\n    goals: [a]\n    since: soon\n`))).toThrow(/YYYY-MM-DD/);
  });

  test("an unconfigured goal chain is registered but never due", () => {
    const root = vault(NATIVE_YAML, at("2026-08-02"));
    expect(CHAINS).toContain(goalChain);
    expect(chainHasWork(goalChain.due(root, { now: now() }))).toBe(false);
  });
});

describe("the goal chain", () => {
  test("a backfill replays week by week: each week is read against the picture before it", async () => {
    const root = vault(GOALS_YAML(), at("2026-08-02"), at("2026-08-03"), at("2026-08-10"), at("2026-08-20"), at("2026-08-24"));
    const m = scripted();
    const result = await runGoals({ root, manifest: loadManifest(root), runner: m.runner, now });
    expect(result.windows.map((w) => [w.covers.from.slice(0, 10), w.covers.through.slice(0, 10), w.gardened, w.picture?.rebuilt]))
      .toEqual([
        ["2026-08-01", "2026-08-08", 2, true],
        ["2026-08-08", "2026-08-15", 1, true],
        ["2026-08-15", "2026-08-22", 1, true],
        ["2026-08-22", "2026-08-29", 1, undefined], // gardened, but its window has not closed
      ]);
    const shown = (title: string) => m.sources().find((c) => c.prompt.includes(`title: ${title}`))!.instructions!;
    expect(shown("item-2026-08-02")).toContain("none yet");
    expect(shown("item-2026-08-10")).toContain("PICTURE v1");
    expect(shown("item-2026-08-20")).toContain("PICTURE v2");
    expect(shown("item-2026-08-24")).toContain("PICTURE v3");
    // every picture is kept; the newest is what the gardener reads next
    expect(pictureRecords(root).map((r) => r.picture)).toEqual(["PICTURE v1", "PICTURE v2", "PICTURE v3"]);
    expect(latestPicture(root)!.picture).toBe("PICTURE v3");
    expect(readGoalLog(root)).toHaveLength(5);
    // nothing left to garden; the open window's picture waits for its clock
    const due = goalChain.due(root, { now: now() });
    expect(due.source).toBe(0);
    expect(due.scheduled.memory).toMatchObject({ due: false });
  });

  test("the picture reads only the assertion field: relevance never feeds back", async () => {
    const root = vault(GOALS_YAML(), at("2026-08-02"));
    const m = scripted();
    await runGoals({ root, manifest: loadManifest(root), runner: m.runner, now });
    const picture = m.pictures()[0]!;
    expect(picture.prompt).toContain("said item-2026-08-02");
    expect(picture.prompt).not.toContain("RELEVANCE");
    expect(picture.instructions).toContain("This picture is read by a gardener");
    expect(picture.capabilities).toBe("none");
    expect(picture.role).toBe("goals");
  });

  test("a source is shown with the door's grade of its sender", () => {
    const relay = insertion({ envelope: { source: "mcp", from: "Claude Code", from_kind: "agent" } });
    const lines = renderGoalSource(relay).split("\n");
    expect(lines.slice(0, 5)).toEqual(["SOURCE", `title: ${relay.title}`, "from: Claude Code", "from_kind: agent", "via: mcp"]);
  });

  test("the Gardener writes only about_goals, whatever the model labels them", async () => {
    const root = vault(GOALS_YAML(), at("2026-08-02"));
    const m = scripted((t) => [{ type: "action_space", assertion: `goal ${t}`, relevance: "r" }]);
    await runGoals({ root, manifest: loadManifest(root), runner: m.runner, now });
    expect(readGoalLog(root)[0]!.assertions).toEqual([{ type: "about_goals", assertion: "goal item-2026-08-02", relevance: "r" }]);
    expect(m.sources()[0]!.output!.schema).not.toHaveProperty("properties.assertions.items.properties.type");
    expect(m.sources()[0]!.instructions).not.toContain("action space");
  });

  test("an empty answer settles the arrival; a window with no goal assertions advances without a model call", async () => {
    const root = vault(GOALS_YAML(), at("2026-08-02"));
    const m = scripted(() => []);
    const result = await runGoals({ root, manifest: loadManifest(root), runner: m.runner, now });
    expect(readGoalLog(root)[0]!.assertions).toEqual([]);
    expect(m.pictures()).toHaveLength(0);
    expect(result.windows[0]!.picture).toMatchObject({ rebuilt: false });
    expect(pictureRecords(root).map((r) => [r.covers.through.slice(0, 10), r.picture])).toEqual([
      ["2026-08-08", "none yet"], ["2026-08-15", "none yet"], ["2026-08-22", "none yet"],
    ]);
  });

  test("a run gardens at most `batch` arrivals, so a backfill drains tick by tick", async () => {
    const root = vault(GOALS_YAML("    batch: 1\n"), at("2026-08-02"), at("2026-08-03"));
    const m = scripted();
    const first = await runGoals({ root, manifest: loadManifest(root), runner: m.runner, now });
    expect(first.windows).toHaveLength(1);
    expect(first.windows[0]).toMatchObject({ gardened: 1 });
    expect(first.windows[0]!.picture).toBeUndefined();
    expect(goalChain.due(root, { now: now() }).source).toBe(1);
  });

  test("a source that keeps failing stays due and holds its window's picture", async () => {
    const root = vault(GOALS_YAML(), at("2026-08-02"));
    const runner = async (req: ModelRunRequest) => {
      if (req.output?.schema) return { text: "not json", sessionId: "s", wallMs: 1 };
      throw new Error("no picture expected");
    };
    const result = await runGoals({ root, manifest: loadManifest(root), runner, now });
    expect(result.windows[0]!.failed).toHaveLength(1);
    expect(goalChain.report(result).failed).toBe(true);
    expect(goalChain.due(root, { now: now() }).source).toBe(1);
    expect(pictureRecords(root)).toEqual([]);
  });

  test("its events never settle the classic chain's intake", async () => {
    const root = vault(GOALS_YAML(), at("2026-08-02"));
    const before = dueIntakeIds(root);
    await runGoals({ root, manifest: loadManifest(root), runner: scripted().runner, now });
    expect(readGoalLog(root)).toHaveLength(1);
    expect(dueIntakeIds(root)).toEqual(before);
  });

  test("single-flight on its own lock", async () => {
    const root = vault(GOALS_YAML(), at("2026-08-02"));
    const lock = join(root, ".state", "goals.lock");
    expect(acquire(lock, "goals")).toBe(true);
    try {
      const r = await runGoals({ root, manifest: loadManifest(root), runner: scripted().runner, now });
      expect(r).toMatchObject({ ran: false, reason: "another goal run holds the lock" });
    } finally { release(lock); }
  });
});
