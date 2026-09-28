/**
 * noteMatch.test.ts — the block window (lib/noteMatch.ts).
 *
 * The live failure this answers: an agent fetched a 290KB agent-chat
 * transcript through /v1/note, got head and tail, and hand-wrote grep and
 * python against a temp file to reach the three turns it wanted. The window
 * IS that grep, so it has to behave like one: same input, same bytes, the
 * turn that matched plus the turn either side, and an honest account of what
 * it skipped.
 */

import { describe, expect, test } from "bun:test";
import {
  bodyBlocks,
  containsAllTerms,
  matchBody,
  matchTerms,
  stripLinks,
} from "../lib/noteMatch";

/** A transcript the way lib/agentChat.ts renderTurns writes one: speaker,
 * colon, text, one blank line between turns. */
const transcript = (turns: [string, string][]): string =>
  turns.map(([who, what]) => `${who}: ${what}`).join("\n\n");

const TURNS: [string, string][] = [
  ["user", "morning — where did we land on the installer?"],
  ["assistant", "the installer re-renders the launchd jobs each run."],
  ["user", "and the queue?"],
  ["assistant", "the queue is a view over the log, never a second table."],
  ["user", "right. what about pricing?"],
  ["assistant", "pricing routes tokens to the user — BYO model."],
  ["user", "ok, back to the installer later."],
];

describe("blocks", () => {
  test("a transcript's turns are its blocks, with the line span of each", () => {
    const blocks = bodyBlocks(transcript(TURNS));
    expect(blocks.length).toBe(TURNS.length);
    expect(blocks[0]).toEqual({ text: "user: morning — where did we land on the installer?", from: 1, to: 1 });
    // Turn n sits on line 2n+1: one line of text, one blank line between.
    expect(blocks[3]?.from).toBe(7);
    expect(blocks.at(-1)?.to).toBe(13);
  });

  test("a multi-line block stays one block", () => {
    const blocks = bodyBlocks("---\ntitle: X\n---\n\nfirst\nsecond\n\nthird\n");
    expect(blocks.map((b) => b.text)).toEqual(["---\ntitle: X\n---", "first\nsecond", "third"]);
    expect(blocks[1]).toMatchObject({ from: 5, to: 6 });
  });

  test("an empty body has no blocks", () => {
    expect(bodyBlocks("")).toEqual([]);
    expect(bodyBlocks("\n\n  \n")).toEqual([]);
  });
});

describe("the all-terms vocabulary", () => {
  test("terms are lowercased words; punctuation alone yields none", () => {
    expect(matchTerms("Pricing, tokens!")).toEqual(["pricing", "tokens"]);
    expect(matchTerms("nick@example.com")).toEqual(["nick@example.com"]);
    expect(matchTerms("??? !!!")).toEqual([]);
  });

  test("EVERY term must appear, and a link matches on its label", () => {
    expect(containsAllTerms("pricing routes tokens", ["pricing", "tokens"])).toBe(true);
    expect(containsAllTerms("pricing routes tokens", ["pricing", "kubernetes"])).toBe(false);
    expect(stripLinks("[[ent_abc|Ada Lovelace]] and [[bare]]")).toBe("Ada Lovelace and bare");
    expect(containsAllTerms("[[ent_abc|Ada Lovelace]] wrote it", ["ada"])).toBe(true);
    // …and never on the id the projection hid behind the label.
    expect(containsAllTerms("[[ent_abc|Ada Lovelace]] wrote it", ["ent_abc"])).toBe(false);
  });
});

describe("matchBody", () => {
  const body = transcript(TURNS);

  test("the matching turn arrives with the turns either side, and the rest is marked elided", () => {
    const w = matchBody(body, "queue", { slack: 1 });
    expect(w.blocks_total).toBe(7);
    expect(w.blocks_matched).toBe(2); // "and the queue?" and the answer
    expect(w.blocks_shown).toBe(4); // both, plus one turn of slack each side
    expect(w.blocks_dropped).toBe(0);
    expect(w.text).toContain("the queue is a view over the log");
    expect(w.text).toContain("user: and the queue?");
    // Turn 2 (line 3) is the slack before; turn 5 (line 9) the slack after.
    expect(w.text).toContain("the installer re-renders");
    expect(w.text).toContain("what about pricing?");
    // What it did NOT show is named by the lines of the whole note, so the
    // next read goes straight there.
    expect(w.text).toContain("[… lines 1–1 elided …]");
    expect(w.text).toContain("[… lines 11–13 elided …]");
    expect(w.text).not.toContain("morning —");
  });

  test("slack=0 is the matching turns and nothing else", () => {
    const w = matchBody(body, "queue", { slack: 0 });
    expect(w.blocks_shown).toBe(2);
    expect(w.text).not.toContain("the installer re-renders");
  });

  test("neighbouring matches merge into one region instead of repeating turns", () => {
    const w = matchBody(body, "installer", { slack: 3 });
    // Turns 1 and 7 both match; ±3 covers everything, and the answer is one
    // unbroken passage with no elision marker inside it.
    expect(w.blocks_shown).toBe(7);
    expect(w.text).not.toContain("elided");
  });

  test("every term must appear in the SAME block", () => {
    // "queue" and "pricing" each appear, but never together in one turn.
    expect(matchBody(body, "queue pricing").blocks_matched).toBe(0);
    expect(matchBody(body, "pricing tokens").blocks_matched).toBe(1);
  });

  test("no match is an empty window that still counts the note", () => {
    const w = matchBody(body, "kubernetes");
    expect(w).toMatchObject({ blocks_total: 7, blocks_matched: 0, blocks_shown: 0, text: "" });
  });

  test("a punctuation-only query matches nothing rather than everything", () => {
    expect(matchBody(body, "???").blocks_matched).toBe(0);
  });

  test("the budget stops at a block boundary and says how many matches it dropped", () => {
    const many = transcript(
      Array.from({ length: 200 }, (_, i) => ["user", `turn ${i} mentions the queue`] as [string, string])
    );
    const w = matchBody(many, "queue", { slack: 0, budget: 1000 });
    expect(w.blocks_matched).toBe(200);
    expect(w.blocks_shown).toBeLessThan(60);
    expect(w.blocks_dropped).toBe(w.blocks_matched - w.blocks_shown);
    expect(w.text.length).toBeLessThan(1500);
    expect(w.text).toContain("elided");
  });

  test("one enormous block is clipped around its first matching term, not dropped", () => {
    const w = matchBody(`${"filler. ".repeat(2000)}THE NEEDLE${" trailer.".repeat(2000)}`, "needle");
    expect(w.blocks_shown).toBe(1);
    expect(w.text).toContain("THE NEEDLE");
    expect(w.text.length).toBeLessThan(2600);
    expect(w.text.startsWith("… ")).toBe(true);
    expect(w.text.endsWith(" …")).toBe(true);
  });

  test("the same body and query give the same bytes", () => {
    expect(matchBody(body, "queue")).toEqual(matchBody(body, "QUEUE"));
  });
});
