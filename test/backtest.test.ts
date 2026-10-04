import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { backtestGoals } from "../lib/backtest";
import { pictureRecords } from "../lib/goalChain";
import { appendGoalEvent, createGoalEvent } from "../lib/goalLog";
import { machineTools } from "../lib/run/machineTools";
import type { ModelRunRequest } from "../lib/run/request";
import { insertionSeq, nativeVault, NATIVE_YAML } from "./support/vault";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};

const insertion = insertionSeq();
const at = (date: string, title: string) =>
  insertion({ received_at: `${date}T12:00:00.000Z`, occurred_at: `${date}T12:00:00.000Z`, title });

const YAML = `${NATIVE_YAML}chains:
  goals:
    goals:
      - "Grow tomatoes. Patience, soil, sun."
      - "Learn the cello."
    since: 2026-08-01
`;

/** A source vault with three weeks of arrivals, each already gardened by the
 * live chain (one recorded goal event per arrival). */
function sourceVault(opts: { unrecorded?: boolean } = {}) {
  const arrivals = [at("2026-08-02", "seeds"), at("2026-08-10", "cello-teacher"), at("2026-08-17", "first-harvest")];
  const root = nativeVault({ prefix: "bb-bt-src-", insertions: arrivals, files: { "vault.yaml": YAML } });
  scratch.push(root);
  for (const a of opts.unrecorded ? arrivals.slice(0, 1) : arrivals)
    appendGoalEvent(root, createGoalEvent({
      insertion_id: a.id, source_id: a.source_id,
      assertions: [{ type: "about_goals", assertion: `WEEK-${a.title}`, relevance: `REL-${a.title}` }],
      author: { kind: "model", id: "recorded", invocation_id: "live" },
      created_at: "2026-10-01T00:00:00.000Z",
      produced_by: { procedure: "goals/source", version: "v1" },
    }));
  return root;
}

const listing = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${relative(root, p)}:${statSync(p).size}`);
    }
  };
  walk(root);
  return out.sort();
};

/** A scripted picture model. In agent mode it also calls its own tools,
 * the way a real agent would, and keeps what they returned. */
function scripted() {
  const calls: { req: ModelRunRequest; searched?: unknown }[] = [];
  const runner = async (req: ModelRunRequest) => {
    const call: { req: ModelRunRequest; searched?: unknown } = { req };
    if (req.capabilities === "goals")
      call.searched = await machineTools(req.root, req.role).find((t) => t.name === "search_goals")!.call({});
    calls.push(call);
    return { text: `PICTURE ${calls.length}`, sessionId: "s", wallMs: 1 };
  };
  return { runner, calls };
}

describe("backtest goals", () => {
  test("replays week by week into a sandbox; the source vault is never written", async () => {
    const source = sourceVault();
    const before = listing(source);
    const out = tmp("bb-bt-out-");
    const m = scripted();
    const result = await backtestGoals({ source, out, through: "2026-08-22", runner: m.runner });
    expect(result.stopped).toBeUndefined();
    expect(pictureRecords(result.sandbox).map((r) => [r.covers.through.slice(0, 10), r.picture]))
      .toEqual([["2026-08-08", "PICTURE 1"], ["2026-08-15", "PICTURE 2"], ["2026-08-22", "PICTURE 3"]]);
    expect(existsSync(join(result.sandbox, ".git"))).toBe(true);
    expect(listing(source)).toEqual(before);
  });

  test("no peeking ahead: each week's picture sees only what had arrived", async () => {
    const m = scripted();
    await backtestGoals({ source: sourceVault(), out: tmp("bb-bt-out-"), through: "2026-08-22", runner: m.runner });
    expect(m.calls[0]!.req.prompt).toContain("WEEK-seeds");
    expect(m.calls[0]!.req.prompt).not.toContain("WEEK-cello-teacher");
    expect(m.calls[1]!.req.prompt).toContain("WEEK-cello-teacher");
    expect(m.calls[1]!.req.prompt).not.toContain("WEEK-first-harvest");
    for (const c of m.calls) expect(c.req.prompt).not.toContain("REL-");
  });

  test("agent mode: read-only goal tools, which also cannot see the future or relevance", async () => {
    const m = scripted();
    await backtestGoals({ source: sourceVault(), out: tmp("bb-bt-out-"), through: "2026-08-15", runner: m.runner, pictureMode: "agent" });
    const first = m.calls[0]!;
    expect(first.req).toMatchObject({ role: "goals-picture", capabilities: "goals" });
    expect(first.req.instructions).toContain("Rebuild the model from the record each time");
    expect(first.req.prompt).toMatch(/\[ins_\w+ · 2026-08-02 · /);
    expect(machineTools(first.req.root, "goals-picture").map((t) => t.name)).toEqual(["search_goals", "read_source"]);
    const rows = (first.searched as { rows: { assertion: string }[] }).rows;
    expect(rows.map((r) => r.assertion)).toEqual(["WEEK-seeds"]);
    expect(JSON.stringify(first.searched)).not.toContain("REL-");
  });

  test("recorded mode never calls the source model; an unrecorded arrival stops the replay", async () => {
    const m = scripted();
    const result = await backtestGoals({ source: sourceVault({ unrecorded: true }), out: tmp("bb-bt-out-"), through: "2026-08-22", runner: m.runner });
    expect(result.stopped).toMatch(/no recorded goal event/);
    expect(m.calls.every((c) => !c.req.output?.schema)).toBe(true);
  });

  test("an arrival superseded before the live chain ran is marked, not re-gardened; its revision replays when it lands", async () => {
    const original = at("2026-08-02", "meeting-v1");
    const revision = insertion({
      source_id: original.source_id, title: "meeting-v2",
      received_at: "2026-08-10T12:00:00.000Z", occurred_at: "2026-08-02T12:00:00.000Z",
      envelope: { ...original.envelope, supersedes: original.id },
    });
    const source = nativeVault({ prefix: "bb-bt-src-", insertions: [original, revision], files: { "vault.yaml": YAML } });
    scratch.push(source);
    appendGoalEvent(source, createGoalEvent({
      insertion_id: revision.id, source_id: revision.source_id,
      assertions: [{ type: "about_goals", assertion: "WEEK-revision", relevance: "r" }],
      author: { kind: "model", id: "recorded", invocation_id: "live" }, created_at: "2026-10-01T00:00:00.000Z",
      produced_by: { procedure: "goals/source", version: "v1" },
    }));
    const m = scripted();
    const result = await backtestGoals({ source, out: tmp("bb-bt-out-"), through: "2026-08-15", runner: m.runner, pictureMode: "agent" });
    expect(result.stopped).toBeUndefined();
    expect(result.superseded).toBe(1);
    expect(m.calls).toHaveLength(1); // week 1 had nothing to say; week 2 read the revision
    expect(m.calls[0]!.req.prompt).toContain("WEEK-revision");
    expect(m.calls[0]!.req.prompt.startsWith("AS OF 2026-08-15")).toBe(true);
  });

  test("the sandbox may not live inside the source vault", async () => {
    const source = sourceVault();
    await expect(backtestGoals({ source, out: join(source, "bt"), through: "2026-08-22", runner: scripted().runner }))
      .rejects.toThrow(/inside the source vault/);
  });
});
