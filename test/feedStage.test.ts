import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAssertionEvent, createAssertionEvent, type AssertionEvent } from "../lib/assertionLog";
import { chainHasWork } from "../lib/chain";
import { addedAt, currentFeed, feedRecords, sortedAssertions } from "../lib/feedJournal";
import { feedDue, feedWork, runFeed } from "../lib/feedStage";
import type { SourceInsertion } from "../lib/insertionLog";
import { loadManifest } from "../lib/manifest";
import type { ModelRunRequest } from "../lib/run/request";
import { classicChain, runTend } from "../lib/tend";
import { insertionSeq, nativeVault, NATIVE_YAML } from "./support/vault";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const insertion = insertionSeq();
const FEED_YAML = (extra = "") => `${NATIVE_YAML}feed:\n  since: 2026-08-10\n${extra}`;

const vault = (yaml: string, ...insertions: SourceInsertion[]): string => {
  const root = nativeVault({ prefix: "bb-feed-", insertions, files: { "vault.yaml": yaml } });
  scratch.push(root);
  return root;
};

let minute = 0;
/** One claim, filed from `source`, at `day`. */
function claim(root: string, source: SourceInsertion, text: string, day = "2026-08-20"): AssertionEvent {
  const event = createAssertionEvent({
    text, entities: [], sources: [source.id],
    author: { kind: "model", id: "test", invocation_id: `run-${++minute}` },
    confidence: "direct",
    created_at: `${day}T12:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    produced_by: { procedure: "test", version: "v1" },
  }, new Map([[source.id, source]]));
  appendAssertionEvent(root, event);
  return event;
}

/** A scripted model: places each SOURCE by a word in its title. Every
 * request is kept so a test can read what each call was shown. */
function scripted(place: (title: string) => { section: string; expires?: string | null } = () => ({ section: "know" })) {
  const calls: ModelRunRequest[] = [];
  const runner = async (req: ModelRunRequest) => {
    calls.push(req);
    const titles = [...req.prompt.matchAll(/^title: (.*)$/gm)].map((m) => m[1]!);
    const entries = titles.map((title, i) => ({ source: i + 1, headline: `headline for ${title}`, expires: null, ...place(title) }));
    return { text: JSON.stringify({ entries }), sessionId: "s", wallMs: 1,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, cost_usd: 0.01 } };
  };
  return { runner, calls };
}

const now = () => new Date("2026-08-25T00:00:00.000Z");

describe("vault.yaml feed:", () => {
  test("absent is off; since is required; defaults are Sonnet, hourly, 10 a call, 100 a run", () => {
    expect(loadManifest(vault(NATIVE_YAML)).feed).toBeUndefined();
    expect(() => loadManifest(vault(`${NATIVE_YAML}feed:\n  model: x\n`))).toThrow(/feed.since/);
    const cfg = loadManifest(vault(FEED_YAML())).feed!;
    expect(cfg.target).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect([cfg.since, cfg.interval, cfg.intervalMs, cfg.batch, cfg.max]).toEqual(["2026-08-10", "1h", 3_600_000, 10, 100]);
  });

  test("off: the classic chain's feed stage is never due", () => {
    const a = insertion({ title: "garden" });
    const root = vault(NATIVE_YAML, a);
    claim(root, a, "The tomatoes need staking.");
    expect(feedDue(root, loadManifest(root).feed, { now: now() })).toMatchObject({ due: false, reason: expect.stringMatching(/off/) });
    expect(classicChain.due(root, { now: now() }).scheduled.feed?.due).toBe(false);
  });
});

describe("the feed stage", () => {
  test("due when claims since `since` wait; claims before it are never sorted", () => {
    const a = insertion({ title: "old" }), b = insertion({ title: "new" });
    const root = vault(FEED_YAML(), a, b);
    claim(root, a, "An old claim about the garden.", "2026-08-01");
    claim(root, b, "A new claim about the garden.");
    const cfg = loadManifest(root).feed!;
    expect(feedWork(root, cfg).map(([key]) => key)).toEqual([b.id]);
    expect(chainHasWork(classicChain.due(root, { now: now() }))).toBe(true);
  });

  test("one call per batch, each source with all its claims, today, and the working set", async () => {
    const [a, b, c] = [insertion({ title: "alpha" }), insertion({ title: "beta" }), insertion({ title: "gamma" })];
    const root = vault(FEED_YAML("  batch: 2\n"), a, b, c);
    claim(root, a, "Briar asked for the budget by Friday.");
    claim(root, a, "The budget covers two engineers.");
    claim(root, b, "The cello lesson moved to Tuesday.");
    claim(root, c, "A newsletter about soil.");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "MEMORY.md"), "# Memory\n\nWORKING-SET-MARKER\n");
    const m = scripted();
    const result = await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now });
    expect(result.calls.map((c) => c.sources)).toEqual([2, 1]);
    expect(m.calls[0]!.role).toBe("feed");
    expect(m.calls[0]!.prompt).toContain("TODAY 2026-08");
    expect(m.calls[0]!.prompt).toContain("WORKING-SET-MARKER");
    expect(m.calls[0]!.prompt).toContain("- Briar asked for the budget by Friday.\n- The budget covers two engineers.");
    expect(m.calls[0]!.instructions).not.toContain("{{OWNER}}");
    const records = feedRecords(root);
    expect(records).toHaveLength(2);
    expect(records[0]!.model).toBe("claude-sonnet-5-5");
    expect(sortedAssertions(records).size).toBe(4);
    expect(feedWork(root, loadManifest(root).feed!)).toEqual([]);
  });

  test("the feed is each source's newest entry, without skips or lapsed dates", async () => {
    const [a, b, c] = [insertion({ title: "urgent" }), insertion({ title: "noise" }), insertion({ title: "party" })];
    const root = vault(FEED_YAML(), a, b, c);
    claim(root, a, "Sign the permit form by Friday.");
    claim(root, b, "A coupon for ten percent off.");
    claim(root, c, "The party was on Saturday.");
    const m = scripted((t) => t === "urgent" ? { section: "needs-you" } : t === "noise" ? { section: "skip" } : { section: "know", expires: "2026-08-23" });
    await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now });
    const feed = currentFeed(feedRecords(root), "2026-08-25");
    expect(feed.map((e) => [e.section, e.headline])).toEqual([["needs-you", "headline for urgent"]]);
    expect(currentFeed(feedRecords(root), "2026-08-22").map((e) => e.source)).toEqual([a.id, c.id]);
  });

  test("a source that gains a claim is judged again, whole; the newest entry wins", async () => {
    const a = insertion({ title: "thread" });
    const root = vault(FEED_YAML(), a);
    claim(root, a, "Kit proposed a call.");
    const first = scripted(() => ({ section: "know" }));
    await runFeed({ root, manifest: loadManifest(root), runner: first.runner, now });
    claim(root, a, "Kit now needs an answer by Monday.");
    const second = scripted(() => ({ section: "needs-you" }));
    await runFeed({ root, manifest: loadManifest(root), runner: second.runner, now: () => new Date("2026-08-25T02:00:00.000Z") });
    expect(second.calls[0]!.prompt).toContain("- Kit proposed a call.\n- Kit now needs an answer by Monday.");
    expect(currentFeed(feedRecords(root), "2026-08-25").map((e) => e.section)).toEqual(["needs-you"]);
    // it entered the feed with the first call; being judged again doesn't re-date it
    const records = feedRecords(root);
    expect(addedAt(records).get(a.id)).toBe(records[0]!.completed_at);
    expect(records[1]!.completed_at).not.toBe(records[0]!.completed_at);
  });

  test("a failed call journals its error, sorts nothing, and waits a full interval", async () => {
    const a = insertion({ title: "x" });
    const root = vault(FEED_YAML(), a);
    claim(root, a, "Something happened today.");
    const result = await runFeed({ root, manifest: loadManifest(root), now, runner: async () => { throw new Error("model down"); } });
    expect(result.calls[0]!.error).toBe("model down");
    const cfg = loadManifest(root).feed!;
    expect(feedRecords(root)[0]!.error?.message).toBe("model down");
    expect(feedWork(root, cfg)).toHaveLength(1);
    expect(feedDue(root, cfg, { now: new Date("2026-08-25T00:30:00.000Z") })).toMatchObject({ due: false });
    expect(feedDue(root, cfg, { now: new Date("2026-08-25T01:00:01.000Z") })).toMatchObject({ due: true });
  });

  test("after a call that succeeded, the next claim filed is due at once", async () => {
    const [a, b] = [insertion({ title: "first" }), insertion({ title: "second" })];
    const root = vault(FEED_YAML(), a, b);
    claim(root, a, "Briar booked the venue.");
    await runFeed({ root, manifest: loadManifest(root), runner: scripted(() => ({ section: "know" })).runner, now });
    const cfg = loadManifest(root).feed!;
    expect(feedDue(root, cfg, { now: now() })).toMatchObject({ due: false, reason: "nothing new to sort" });
    claim(root, b, "Kit needs the slides tonight.");
    expect(feedDue(root, cfg, { now: now() })).toMatchObject({ due: true });
  });

  test("tend runs the feed after memory when it is due, and not when it is off", async () => {
    const a = insertion({ title: "y" });
    const on = vault(FEED_YAML(), a);
    claim(on, a, "Something happened today.");
    let ran = 0;
    const feedRunner = async () => { ran++; return { ran: true, calls: [] }; };
    const result = await runTend({ root: on, manifest: loadManifest(on), feedRunner, now });
    expect(ran).toBe(1);
    expect(classicChain.report(result).lines).toContain("tend: feed — 0 source(s) sorted in 0 call(s)");

    const off = vault(NATIVE_YAML, a);
    claim(off, a, "Something happened today.");
    await runTend({ root: off, manifest: loadManifest(off), feedRunner, now });
    expect(ran).toBe(1);
  });
});
