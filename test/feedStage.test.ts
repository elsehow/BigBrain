import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent, type AssertionEvent } from "../lib/assertionLog";
import { chainHasWork } from "../lib/chain";
import { feedConversationOf } from "../lib/feedConversation";
import { addedAt, currentFeed, dueOf, feedRecords, sortedAssertions } from "../lib/feedJournal";
import { FEED_PROMPT_VERSION, feedDue, feedLockFile, feedWork, runFeed } from "../lib/feedStage";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { loadManifest } from "../lib/manifest";
import type { ModelRunRequest } from "../lib/run/request";
import { classicChain, runTend } from "../lib/tend";
import { declareUserIdentity } from "../lib/userIdentity";
import { holdElsewhere } from "./support/lockElsewhere";
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
/** One claim, filed from `source`, at `day`, about the entities it links. */
function claim(root: string, source: SourceInsertion, text: string, day = "2026-08-20"): AssertionEvent {
  const entities = [...text.matchAll(/\[\[(ent_[a-f0-9]{20})\|([^\]]+)\]\]/g)].map((m) => ({ id: m[1]!, label: m[2]! }));
  const event = createAssertionEvent({
    text, entities, sources: [source.id],
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
function scripted(place: (title: string) => { section: string; due?: string | null } = () => ({ section: "know" })) {
  const calls: ModelRunRequest[] = [];
  const runner = async (req: ModelRunRequest) => {
    calls.push(req);
    const titles = [...req.prompt.matchAll(/^title: (.*)$/gm)].map((m) => m[1]!);
    const entries = titles.map((title, i) => ({ source: i + 1, headline: `headline for ${title}`, due: null, ...place(title) }));
    return { text: JSON.stringify({ entries }), sessionId: "s", wallMs: 1,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, cost_usd: 0.01 } };
  };
  return { runner, calls };
}

const now = () => new Date("2026-08-25T00:00:00.000Z");
/** A clock that moves a second per reading, so each call lands after the last. */
const ticking = (from = "2026-08-25T00:00:00.000Z") => { let t = Date.parse(from); return () => new Date(t += 1000); };
const who = (label: string) => `[[${assertionEntityId(label)}|${label}]]`;
const feedNow = (root: string) => {
  const records = feedRecords(root);
  return currentFeed(records, feedConversationOf(root, records));
};
/** One email of a thread: the subject is long enough to join on its own. */
const mail = (title: string, at: string, over: Partial<SourceInsertion> = {}) => {
  const event = insertion({ title, received_at: at, ...over });
  return { ...event, envelope: { id: event.source_id, source: "email", kind: "email", ...over.envelope } };
};

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
    expect(feedWork(root, cfg).map((c) => c.messages.at(-1)!.id)).toEqual([b.id]);
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

  test("the feed is each source's newest entry, without skips; a date passing takes nothing away", async () => {
    const [a, b, c] = [insertion({ title: "urgent" }), insertion({ title: "noise" }), insertion({ title: "party" })];
    const root = vault(FEED_YAML(), a, b, c);
    claim(root, a, "Sign the permit form by Friday.");
    claim(root, b, "A coupon for ten percent off.");
    claim(root, c, "The party is on the 23rd.");
    const m = scripted((t) => t === "urgent" ? { section: "needs-you", due: "2026-08-21" } : t === "noise" ? { section: "skip" } : { section: "know" });
    await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now });
    expect(currentFeed(feedRecords(root)).map((e) => [e.section, e.headline])).toEqual([["needs-you", "headline for urgent"], ["know", "headline for party"]]);
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
    expect(currentFeed(feedRecords(root)).map((e) => e.section)).toEqual(["needs-you"]);
    // it entered the feed with the first call; being judged again doesn't re-date it
    const records = feedRecords(root);
    expect(addedAt(records).get(a.id)).toBe(records[0]!.completed_at);
    expect(records[1]!.completed_at).not.toBe(records[0]!.completed_at);
  });

  test("every landing of one source is one conversation: the revision's claims stand in for the last landing's", async () => {
    const first = insertion({ source_id: "src-standup", title: "standup" });
    const root = vault(FEED_YAML(), first);
    claim(root, first, "Kit proposed a call.");
    await runFeed({ root, manifest: loadManifest(root), runner: scripted(() => ({ section: "needs-you" })).runner, now: ticking() });
    const revised = insertion({ source_id: "src-standup", title: "standup", envelope: { id: "src-standup", kind: "meeting", supersedes: first.id } });
    appendSourceInsertionEvent(root, revised);
    claim(root, revised, "Kit proposed a call on Monday.");
    const work = feedWork(root, loadManifest(root).feed!);
    expect(work.map((c) => c.messages.map((m) => m.id))).toEqual([[revised.id]]);
    const second = scripted(() => ({ section: "know" }));
    await runFeed({ root, manifest: loadManifest(root), runner: second.runner, now: ticking("2026-08-25T02:00:00.000Z") });
    expect(second.calls[0]!.prompt).toContain("- Kit proposed a call on Monday.");
    expect(second.calls[0]!.prompt).not.toContain("- Kit proposed a call.");
    // one place in the feed, the revision's; read by arrival, it was two
    expect(feedNow(root).map((e) => [e.source, e.section])).toEqual([[revised.id, "know"]]);
    expect(currentFeed(feedRecords(root))).toHaveLength(2);
  });

  test("a thread is one conversation, judged whole and oldest first: their mail, your draft, what you sent", async () => {
    const subject = "The cello lesson schedule for autumn";
    const ask = mail(subject, "2026-08-20T09:00:00.000Z");
    const draft = mail(`Re: ${subject}`, "2026-08-20T11:00:00.000Z", { envelope: { labels: ["\\Draft"] } });
    const sent = mail(`Re: ${subject}`, "2026-08-20T11:05:00.000Z", { envelope: { labels: ["\\Sent"] } });
    const root = vault(FEED_YAML(), ask, draft, sent);
    claim(root, ask, "Kit asked whether Tuesday works for the cello lesson.");
    await runFeed({ root, manifest: loadManifest(root), runner: scripted(() => ({ section: "needs-you" })).runner, now: ticking() });
    expect(feedNow(root).map((e) => e.section)).toEqual(["needs-you"]);

    claim(root, sent, "You told Kit Tuesday works.");
    claim(root, draft, "Your draft to Kit says Tuesday works.");
    const second = scripted(() => ({ section: "skip" }));
    await runFeed({ root, manifest: loadManifest(root), runner: second.runner, now: ticking("2026-08-25T02:00:00.000Z") });
    const prompt = second.calls[0]!.prompt;
    expect([...prompt.matchAll(/^SOURCE \d+$/gm)]).toHaveLength(1);
    expect(prompt).toContain([
      "[2026-08-20 09:00] The cello lesson schedule for autumn", "- Kit asked whether Tuesday works for the cello lesson.",
      `[2026-08-20 11:00] Re: ${subject}`, "- Your draft to Kit says Tuesday works.",
      `[2026-08-20 11:05] Re: ${subject}`, "- You told Kit Tuesday works.",
    ].join("\n"));
    // its own last headline is about to be replaced: not "recent" to the call judging it
    expect(prompt).toContain("ALREADY IN THE FEED\nnone yet\n");
    expect(feedRecords(root).at(-1)!.entries.map((e) => e.source)).toEqual([sent.id]);
    // what you sent settles it: the thread leaves the feed, its ask with it
    expect(feedNow(root)).toEqual([]);
  });

  test("each call sees the feed's ten newest headlines, the last call's included, and never a skip", async () => {
    const titles = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "noise"];
    const items = titles.map((title) => insertion({ title }));
    const root = vault(FEED_YAML("  batch: 1\n"), ...items);
    for (const item of items) claim(root, item, `Something about ${item.title}.`);
    const m = scripted((t) => ({ section: t === "beta" ? "skip" : "know" }));
    await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now: ticking() });
    const recent = (i: number) => m.calls[i]!.prompt.split("ALREADY IN THE FEED\n")[1]!.split("\n\n")[0];
    expect(recent(0)).toBe("none yet");
    expect(recent(1)).toBe("- headline for alpha");
    expect(recent(2)).toBe("- headline for alpha");
    expect(recent(12)).toBe(["mu", "lambda", "kappa", "iota", "theta", "eta", "zeta", "epsilon", "delta", "gamma"].map((t) => `- headline for ${t}`).join("\n"));
  });

  test("a date is due only where something is to be done by it, never a meeting's own date", async () => {
    const [form, meeting, news] = [insertion({ title: "form" }), insertion({ title: "meeting" }), insertion({ title: "news" })];
    const root = vault(FEED_YAML(), form, meeting, news);
    claim(root, form, "Sign the permit form by the 30th.");
    claim(root, meeting, "Kit accepted the review meeting on the 28th.");
    claim(root, news, "The library extended its hours.");
    const m = scripted((t) => t === "form" ? { section: "needs-you", due: "2026-08-30" }
      : t === "meeting" ? { section: "know" } : { section: "know", due: "2026-08-29" });
    await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now });
    expect(m.calls[0]!.instructions).toContain("`due`");
    expect(m.calls[0]!.instructions).not.toContain("expires");
    expect(feedRecords(root)[0]!.prompt_version).toBe(FEED_PROMPT_VERSION);
    const due = Object.fromEntries(feedNow(root).map((e) => [e.headline, dueOf(e)]));
    // know asks for nothing, so a date it carries is never due
    expect(due).toEqual({ "headline for form": "2026-08-30", "headline for meeting": null, "headline for news": null });
    // before feed/v3 an entry had only expires: due where it asks for action
    const legacy = { source: "ins_x", headline: "h", assertions: [], expires: "2026-08-30" };
    expect(dueOf({ ...legacy, section: "agent" })).toBe("2026-08-30");
    expect(dueOf({ ...legacy, section: "know" })).toBeNull();
    expect(dueOf({ ...legacy, section: "needs-you", due: null })).toBeNull();
  });

  test("an open ask that shares an entity with the news is judged beside it, and the newer judgment settles it", async () => {
    const [ask, done, other] = [insertion({ title: "ask" }), insertion({ title: "done" }), insertion({ title: "elsewhere" })];
    const root = vault(FEED_YAML(), ask, done, other);
    claim(root, ask, `${who("Kit Example")} asked you to add them to the garden chat.`);
    await runFeed({ root, manifest: loadManifest(root), runner: scripted(() => ({ section: "needs-you" })).runner, now: ticking() });
    claim(root, done, `You added ${who("Kit Example")} to the garden chat.`);
    claim(root, other, `${who("Briar Example")} booked the venue.`);
    const m = scripted((t) => t === "ask" ? { section: "skip" } : { section: "know" });
    const result = await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now: ticking("2026-08-25T02:00:00.000Z") });
    expect([...m.calls[0]!.prompt.matchAll(/^title: (.*)$/gm)].map((t) => t[1])).toEqual(["done", "elsewhere", "ask"]);
    expect(result.calls[0]!.sources).toBe(3);
    expect(feedNow(root).map((e) => e.headline).sort()).toEqual(["headline for done", "headline for elsewhere"]);
  });

  test("at most three open asks ride along, most shared first, then newest; the owner relates nothing", async () => {
    const asks = [
      ["a1", ["Kit Example"]], ["a2", ["Briar Example"]], ["a3", ["Kit Example", "Briar Example"]],
      ["a4", ["Kit Example"]], ["a5", ["Briar Example"]], ["a6", ["Robin Example", "Ada Example"]],
    ].map(([title, about]) => ({ source: insertion({ title: title as string }), about: about as string[] }));
    const news = insertion({ title: "news" });
    const root = vault(FEED_YAML("  batch: 1\n"), ...asks.map((a) => a.source), news);
    declareUserIdentity(root, { name: "Robin Example", email: "robin@example.com", now: new Date("2026-08-01T00:00:00.000Z") });
    for (const { source, about } of asks) claim(root, source, `${about.map(who).join(" and ")} asked you for a reply.`);
    await runFeed({ root, manifest: loadManifest(root), runner: scripted(() => ({ section: "needs-you" })).runner, now: ticking() });
    claim(root, news, `${who("Robin Example")} met ${who("Kit Example")} and ${who("Briar Example")} for lunch.`);
    const m = scripted();
    await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now: ticking("2026-08-25T02:00:00.000Z") });
    expect([...m.calls[0]!.prompt.matchAll(/^title: (.*)$/gm)].map((t) => t[1])).toEqual(["news", "a3", "a5", "a4"]);
  });

  test("single-flight: a second run skips, naming the process that holds the lock, and runs once that one is killed", async () => {
    const a = insertion({ title: "garden" });
    const root = vault(FEED_YAML(), a);
    claim(root, a, "The tomatoes need staking.");
    const other = await holdElsewhere("sqliteLock.ts", "tryHold", [feedLockFile(root)]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const m = scripted();
    try {
      expect(await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now }))
        .toEqual({ ran: false, reason: "another feed run holds the lock", calls: [] });
      expect(log).toHaveBeenCalledWith(`feed: another run holds the lock (pid ${other.pid}); exiting`);
    } finally {
      log.mockRestore();
      await other.kill();
    }
    expect(m.calls).toHaveLength(0);
    expect((await runFeed({ root, manifest: loadManifest(root), runner: m.runner, now })).calls).toHaveLength(1);
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
