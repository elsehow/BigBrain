/**
 * markdown.js — the extension's own Turndown rules, imported the way
 * extensionTranscript.test.ts imports transcript.js (an IIFE on globalThis).
 * Turndown itself needs a DOM, so the rules are driven directly: a stub
 * node for `filter`, the content Turndown would have produced for
 * `replacement`. What is pinned is the shape that opened a note with a
 * lone "[" (2026-08-27): an <a> around block children.
 */
import { beforeAll, expect, test } from "bun:test";

type Rule = {
  filter: (node: unknown) => boolean;
  replacement: (content: string, node: unknown) => string;
};
let rule: Rule;
let configure: (td: { addRule: (n: string, r: Rule) => void }) => void;

beforeAll(async () => {
  await import("../clients/browser-extension/markdown.js");
  const M = (globalThis as Record<string, unknown>)["BigBrainMarkdown"] as {
    rules: { blockLink: Rule };
    configure: typeof configure;
  };
  rule = M.rules.blockLink;
  configure = M.configure;
});

// a DOM node, as far as the rule looks at one
const anchor = (href: string, blocks: boolean) => ({
  nodeName: "A",
  getAttribute: (k: string) => (k === "href" ? href : null),
  querySelector: () => (blocks ? {} : null),
});

test("only an anchor with an href AND a block child is claimed", () => {
  expect(rule.filter(anchor("https://x.test/p", true))).toBe(true);
  expect(rule.filter(anchor("https://x.test/p", false))).toBe(false); // Turndown's own `a` rule
  expect(rule.filter(anchor("", true))).toBe(false);
  expect(rule.filter({ ...anchor("https://x.test/p", true), nodeName: "DIV" })).toBe(false);
});

test("Substack's byline collapses to one inline link — the image stays inside it", () => {
  const content = "\n\n![Zvi Mowshowitz's avatar](https://cdn.test/avatar.jpg)\n\nZvi Mowshowitz\n\n";
  expect(rule.replacement(content, anchor("https://substack.com/@thezvi", true))).toBe(
    "[![Zvi Mowshowitz's avatar](https://cdn.test/avatar.jpg) Zvi Mowshowitz](https://substack.com/@thezvi)"
  );
});

test("a long or block-marked card keeps its blocks and gets the href after them, once", () => {
  const card = "## A post title\n\nThe first paragraph of the teaser, long enough to matter.";
  expect(rule.replacement(card, anchor("https://x.test/post", true))).toBe(`${card}\n\n<https://x.test/post>`);
  const long = "x".repeat(300);
  expect(rule.replacement(long, anchor("https://x.test/long", true))).toBe(`${long}\n\n<https://x.test/long>`);
});

test("an empty anchor vanishes", () => {
  expect(rule.replacement("\n\n  \n", anchor("https://x.test", true))).toBe("");
});

test("configure registers every rule by name", () => {
  const added: string[] = [];
  configure({ addRule: (n) => { added.push(n); } });
  expect(added).toEqual(["blockLink"]);
});
