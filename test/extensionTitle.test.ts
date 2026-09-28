import { expect, test } from "bun:test";
import "../clients/browser-extension/title.js";

const { resolve } = (globalThis as any).BigBrainTitle as {
  resolve(input: { title?: string; heading?: string; url: string }): string;
};

test("untitled raw source clips use the source filename", () => {
  const url = "https://wiki.xxiivv.com/etc/uxnmin.tal.txt";
  expect(resolve({ url })).toBe("uxnmin.tal.txt");
  expect(resolve({ title: "Untitled page", url })).toBe("uxnmin.tal.txt");
  expect(resolve({ title: "   ", url })).toBe("uxnmin.tal.txt");
});

test("author titles and headings take precedence over the URL", () => {
  const url = "https://example.com/article";
  expect(resolve({ title: "The author's title", heading: "Heading", url })).toBe("The author's title");
  expect(resolve({ heading: " A useful\n heading ", url })).toBe("A useful heading");
});

test("URL fallback decodes names, excludes queries, and tolerates malformed escapes", () => {
  expect(resolve({ url: "https://example.com/A%20useful%20file.txt?download=1#top" })).toBe("A useful file.txt");
  expect(resolve({ url: "https://example.com/" })).toBe("example.com");
  expect(resolve({ url: "https://example.com/bad%escape.txt" })).toBe("bad%escape.txt");
});
