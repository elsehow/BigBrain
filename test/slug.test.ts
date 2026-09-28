/**
 * lib/slug.ts and its vendored twin (clients/browser-extension/slug.js) —
 * pinning the #265 resolution of the two `.slice(0, 60)` variants that used
 * to exist independently (fsx.ts capped + fell back; graph.ts/links.ts did
 * neither). A bare slug(s) call must match the graph/links behavior; the
 * cap and fallback are opt-in via `opts`.
 */
import { expect, test, describe, beforeAll } from "bun:test";
import { slug } from "../lib/slug";

describe("slug (bare call — graph.ts/links.ts's behavior)", () => {
  test("lowercases, collapses non-alphanumerics, trims edges", () => {
    expect(slug("Ada Lovelace")).toBe("ada-lovelace");
    expect(slug("  Weird!!  Punctuation??  ")).toBe("weird-punctuation");
  });

  test("no length cap", () => {
    const long = "a".repeat(200);
    expect(slug(long)).toBe(long);
  });

  test("no fallback — punctuation-only input slugs to empty string", () => {
    expect(slug("!!!")).toBe("");
    expect(slug("")).toBe("");
  });
});

describe("slug with maxLen + fallback (fsx.ts's slugify behavior)", () => {
  test("caps length", () => {
    const long = "word ".repeat(30); // slugifies to well over 60 chars
    const out = slug(long, { maxLen: 60, fallback: "note" });
    expect(out.length).toBeLessThanOrEqual(60);
  });

  test("falls back when input is empty or slugs to nothing", () => {
    expect(slug("", { maxLen: 60, fallback: "note" })).toBe("note");
    expect(slug("!!!", { maxLen: 60, fallback: "note" })).toBe("note");
  });

  test("under the cap, with real content: behaves exactly like the bare call", () => {
    expect(slug("Ada Lovelace", { maxLen: 60, fallback: "note" })).toBe("ada-lovelace");
  });
});

describe("clients/browser-extension/slug.js — the vendored copy", () => {
  let S: { slug: (s: string, opts?: { maxLen?: number; fallback?: string }) => string };
  beforeAll(async () => {
    await import("../clients/browser-extension/slug.js");
    S = (globalThis as Record<string, unknown>)["BigBrainSlug"] as typeof S;
  });

  test("matches lib/slug.ts's output for the extension's two call shapes", () => {
    expect(S.slug("My Great Page Title", { maxLen: 60, fallback: "page" })).toBe(
      "my-great-page-title"
    );
    expect(S.slug("", { maxLen: 60, fallback: "page" })).toBe("page");
    expect(S.slug("!!!", { maxLen: 60, fallback: "youtube-video" })).toBe("youtube-video");
  });

  test("caps at 60 the same way lib/slug.ts does", () => {
    const long = "word ".repeat(30);
    expect(S.slug(long, { maxLen: 60, fallback: "page" }).length).toBeLessThanOrEqual(60);
  });
});
