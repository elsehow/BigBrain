import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { syncAssertionProjection } from "../lib/assertionProjection";
import { insertionEventRel, type SourceInsertion } from "../lib/insertionLog";
import { OutOfCredits } from "../lib/providerCredits";
import { copyCandidates, copyCutoff, DEFAULT_CUTOFF, foldCopyEvents, sourceCopies } from "../lib/sourceCopies";
import { judgeCopies, type CopyJudge } from "../lib/sourceCopyJudge";
import { createSourceCopyEvent, readSourceCopyLog } from "../lib/sourceCopyLog";
import { copyReview, declareCopies } from "../lib/sourceCopyReview";
import { insertion, nativeVault } from "./support/vault";

const PERSON = { kind: "user" as const, id: "owner@example.com" };
const MODEL = { kind: "model" as const, id: "test-judge", invocation_id: "run-1" };
const PRODUCED = { procedure: "test", version: "1" };
const id = (c: string) => `ins_${c.repeat(24)}`;
const at = (n: number) => `2026-10-0${n}T00:00:00.000Z`;

describe("the copy log", () => {
  test("a judgment is a model's score, a declaration a person's word; either way the pair is one fact", () => {
    const judged = createSourceCopyEvent({ a: id("b"), b: id("a"), score: 0.7, author: MODEL, created_at: at(1), produced_by: PRODUCED });
    expect(judged.pair).toEqual([id("a"), id("b")]);
    expect(() => createSourceCopyEvent({ a: id("a"), b: id("b"), score: 0.7, author: PERSON, created_at: at(1), produced_by: PRODUCED })).toThrow();
    expect(() => createSourceCopyEvent({ a: id("a"), b: id("b"), same: true, author: MODEL, created_at: at(1), produced_by: PRODUCED })).toThrow();
    expect(() => createSourceCopyEvent({ a: id("a"), b: id("b"), score: 1.5, author: MODEL, created_at: at(1), produced_by: PRODUCED })).toThrow();
    expect(() => createSourceCopyEvent({ a: id("a"), b: id("a"), same: true, author: PERSON, created_at: at(1), produced_by: PRODUCED })).toThrow();
  });
});

describe("judgments and a person's word", () => {
  const judged = (pair: string, score: number, t: number) =>
    createSourceCopyEvent({ a: id(pair[0]!), b: id(pair[1]!), score, author: MODEL, created_at: at(t), produced_by: PRODUCED });
  const said = (pair: string, same: boolean, t: number) =>
    createSourceCopyEvent({ a: id(pair[0]!), b: id(pair[1]!), same, author: PERSON, created_at: at(t), produced_by: PRODUCED });

  test("the latest of each kind per pair stands", () => {
    const record = foldCopyEvents([said("ab", true, 1), judged("ab", 0.4, 1), said("ab", false, 2), judged("ab", 0.9, 3)]);
    expect(record.declared.get(`${id("a")}|${id("b")}`)).toBe(false);
    expect(record.judged.get(`${id("a")}|${id("b")}`)?.score).toBe(0.9);
  });

  test("the cut-off is the default until a person has answered enough judged pairs, then the line that agrees with them", () => {
    const pairs = ["ab", "ac", "ad", "ae", "af"];
    const scores = [0.62, 0.7, 0.66, 0.4, 0.55], answers = [true, true, true, false, false];
    const events = pairs.flatMap((p, i) => [judged(p, scores[i]!, 1), said(p, answers[i]!, 2)]);
    expect(copyCutoff(foldCopyEvents(events.slice(0, 8)))).toBe(DEFAULT_CUTOFF);
    expect(copyCutoff(foldCopyEvents(events))).toBe(0.62);
  });

  test("a person's 'not the same' cuts even an exact match", () => {
    const file = { kind: "pdf-import", attachments: [{ name: "x.pdf", sha256: "ab".repeat(32), bytes: 1, mime: "application/pdf" }] };
    const [a, b] = [insertion({ id: id("a"), envelope: file }), insertion({ id: id("b"), envelope: file })];
    expect(sourceCopies([a, b], { stub: () => false }).has(a.id)).toBe(true);
    expect(sourceCopies([a, b], { stub: () => false, apart: () => true }).has(a.id)).toBe(false);
  });
});

describe("copyCandidates", () => {
  const work = (c: string, title: string, kind = "web-clip") => insertion({ id: id(c), title, envelope: { kind } });
  const PAPER = "Tidal Lanterns in Coastal Navigation";

  test("works whose titles name each other: a file name, a subtitle, a publisher's tail", () => {
    const pairs = copyCandidates([
      work("a", `${PAPER}: A Field Survey`), work("b", `${PAPER} - 2604.24698v1.pdf`, "pdf-import"), work("c", `${PAPER} | Harbour Review`),
      work("d", "Lanterns"), work("e", PAPER, "meeting"),
    ]);
    expect(pairs).toEqual(expect.arrayContaining([[id("a"), id("b")], [id("a"), id("c")], [id("b"), id("c")]]));
    expect(pairs.flat()).not.toContain(id("d"));
    expect(pairs.flat()).not.toContain(id("e"));
  });

  test("a title shared by a crowd is generic, never a work's", () => {
    expect(copyCandidates([..."abcdefghi"].map((c) => work(c, "Sign in to your account")))).toEqual([]);
  });
});

describe("copies in the vault", () => {
  const PAPER = "Tidal Lanterns in Coastal Navigation";
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const clip = insertion({ id: id("a"), title: `${PAPER}: A Field Survey`, received_at: at(1), envelope: { kind: "web-clip", url: "https://harbours.example/lanterns" } });
  const scan = insertion({ id: id("b"), title: `${PAPER}.pdf`, received_at: at(2), envelope: { kind: "pdf-import" } });
  const vault = (insertions: SourceInsertion[] = [clip, scan]): string => {
    const root = nativeVault({ prefix: "bb-copy-review-", insertions });
    roots.push(root);
    syncAssertionProjection(root);
    return root;
  };
  const judge = (score: number | Error): CopyJudge => ({ model: "test-judge", judge: async () => { if (score instanceof Error) throw score; return score; } });
  const sourceNodes = (root: string) => buildAssertionGraph(root).nodes.filter((n) => n.group === "source").map((n) => n.id).sort();

  test("an unjudged pair is asked; a judgment over the cut-off makes it one node, and says why", async () => {
    const root = vault();
    expect(copyReview(root, clip.id).proposals).toEqual([{ path: insertionEventRel(scan), title: `${PAPER}.pdf` }]);
    expect(await judgeCopies(root, "", { judge: judge(0.9) })).toEqual({ judged: 1, failed: 0, left: 0 });
    expect(sourceNodes(root)).toHaveLength(1);
    expect(copyReview(root, clip.id)).toEqual({ copies: [{ path: insertionEventRel(scan), title: `${PAPER}.pdf`, why: "judged" }], proposals: [] });
    expect(await judgeCopies(root, "", { judge: judge(0.9) })).toEqual({ judged: 0, failed: 0, left: 0 });
  });

  test("under the cut-off the pair stays asked with its score; a person's 'same' joins it", async () => {
    const root = vault();
    await judgeCopies(root, "", { judge: judge(0.5) });
    expect(copyReview(root, scan.id).proposals).toEqual([{ path: insertionEventRel(clip), title: clip.title, score: 0.5 }]);
    declareCopies(root, { a: insertionEventRel(scan), b: insertionEventRel(clip), same: true }, PERSON);
    expect(copyReview(root, scan.id)).toEqual({ copies: [{ path: insertionEventRel(clip), title: clip.title, why: "you" }], proposals: [] });
    expect(readSourceCopyLog(root).map((e) => e.event).sort()).toEqual(["source.copies-declared", "source.copies-judged"]);
  });

  test("'not the same' splits an exact copy and is never asked again", () => {
    const again = insertion({ id: id("c"), title: "Field notes", received_at: at(3), envelope: { kind: "web-clip", url: "https://harbours.example/lanterns" } });
    const root = vault([clip, again]);
    expect(copyReview(root, again.id).copies.map((c) => c.why)).toEqual(["address"]);
    declareCopies(root, { a: clip.id, b: again.id, same: false }, PERSON);
    expect(copyReview(root, again.id)).toEqual({ copies: [], proposals: [] });
    expect(sourceNodes(root)).toEqual([`source:${clip.id}`, `source:${again.id}`]);
  });

  test("a failed call leaves the pair asked for the next pass; running out of credits ends the pass", async () => {
    const root = vault();
    expect(await judgeCopies(root, "", { judge: judge(new Error("no answer")) })).toEqual({ judged: 0, failed: 1, left: 1 });
    expect(copyReview(root, clip.id).proposals).toHaveLength(1);
    const third = insertion({ id: id("d"), title: `${PAPER} (2026)`, received_at: at(4), envelope: { kind: "web-clip" } });
    const busy = vault([clip, scan, third]);
    let calls = 0;
    const broke: CopyJudge = { model: "test-judge", judge: async () => { calls++; throw new OutOfCredits("typesafe", "out"); } };
    expect((await judgeCopies(busy, "", { judge: broke })).judged).toBe(0);
    expect(calls).toBe(1);
  });
});
