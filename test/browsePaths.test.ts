import { describe, expect, test } from "bun:test";
import { withinRoot } from "../lib/browsePaths";

// The browse jail's lexical half (#259). The feed-builder tests that stood
// beside these went with recentFromGitLog / recentFromReferences on
// 2026-08-30: /api/recent has been served from lib/sourceFeed.ts alone
// since #495, and /v1/recent is gone.

describe("withinRoot — a caller-supplied allowlist (#259)", () => {
  const root = "/vault";
  const trees = ["references", "entities", "journal", "inbox/unsorted"];
  test("a nested entry admits itself and below, never its parent tree", () => {
    expect(withinRoot(root, "inbox/unsorted", trees)).toBe("/vault/inbox/unsorted");
    expect(withinRoot(root, "inbox/unsorted/x.md", trees)).toBe("/vault/inbox/unsorted/x.md");
    expect(withinRoot(root, "inbox", trees)).toBeNull();
    expect(withinRoot(root, "inbox/other.md", trees)).toBeNull();
  });
  test("escapes, absolutes, and the root itself are refused", () => {
    expect(withinRoot(root, "entities/../../etc/passwd", trees)).toBeNull();
    expect(withinRoot(root, "/entities/x.md", trees)).toBeNull();
    expect(withinRoot(root, "entities/..", trees)).toBeNull();
    expect(withinRoot(root, "", trees)).toBeNull();
    // a dotted path that RESOLVES inside an allowed tree is that tree's path
    expect(withinRoot(root, "entities/sub/../x.md", trees)).toBe("/vault/entities/x.md");
  });
});
