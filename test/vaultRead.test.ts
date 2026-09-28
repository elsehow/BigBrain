import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { excerpt, noteView, walkMarkdown } from "../lib/vaultRead";

// Pins the markdown-read core as extracted from lib/api.ts (#259) — the
// the /v1/note tests had already pinned these shapes through the
// route; these pin the helpers directly, so the viewer's adoption
// (web/server.ts's listNotes/countMd) stands on asserted ground.

function vault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bb-vaultread-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

describe("walkMarkdown", () => {
  const FILES = {
    "entities/ada.md": "x",
    "entities/orgs/acme.md": "x",
    "entities/orgs/deep/deeper/nested.md": "x",
    "entities/.hidden/secret.md": "x",
    "entities/.dotfile.md": "x",
    "entities/readme.txt": "x",
    "references/r1.md": "x",
  };

  test("every .md under the named trees, tree order preserved, non-md skipped", () => {
    const root = vault(FILES);
    const out = walkMarkdown(root, ["entities", "references"]);
    expect(out.filter((p) => p.startsWith("references/"))).toEqual(["references/r1.md"]);
    expect(out).toContain("entities/ada.md");
    expect(out).toContain("entities/orgs/acme.md");
    expect(out).toContain("entities/orgs/deep/deeper/nested.md"); // unlimited depth by default
    expect(out).toContain("entities/.dotfile.md"); // the API door does not skip dots
    expect(out).not.toContain("entities/readme.txt");
    // tree order: every entities/ path before every references/ path
    expect(out.indexOf("references/r1.md")).toBe(out.length - 1);
  });

  test("skipDotted drops dot files and dot directories alike", () => {
    const root = vault(FILES);
    const out = walkMarkdown(root, ["entities"], { skipDotted: true });
    expect(out).not.toContain("entities/.dotfile.md");
    expect(out).not.toContain("entities/.hidden/secret.md");
    expect(out).toContain("entities/orgs/acme.md");
  });

  test("maxDepth bounds directory descents: 0 is the tree's own files only", () => {
    const root = vault(FILES);
    expect(walkMarkdown(root, ["entities"], { maxDepth: 0 }).sort()).toEqual([
      "entities/.dotfile.md",
      "entities/ada.md",
    ]);
    const one = walkMarkdown(root, ["entities"], { maxDepth: 1, skipDotted: true });
    expect(one).toContain("entities/orgs/acme.md");
    expect(one).not.toContain("entities/orgs/deep/deeper/nested.md");
  });

  test("cap stops the walk; a missing tree is skipped, not an error", () => {
    const root = vault(FILES);
    expect(walkMarkdown(root, ["entities"]).length).toBeGreaterThan(2);
    expect(walkMarkdown(root, ["entities"], { cap: 2 })).toHaveLength(2);
    expect(walkMarkdown(root, ["nowhere"])).toEqual([]);
  });

  test('a tree of "" walks root itself — the counting caller\'s spelling', () => {
    const root = vault({ "top.md": "x", "sub/inner.md": "x" });
    expect(walkMarkdown(root, [""], { maxDepth: 0 })).toEqual(["top.md"]);
    expect(walkMarkdown(root, [""]).sort()).toEqual(["sub/inner.md", "top.md"]);
  });

  test("a symlinked directory is never descended — dirents, not stats, drive the walk", () => {
    const root = vault({ "entities/a.md": "x" });
    const outside = mkdtempSync(join(tmpdir(), "bb-outside-"));
    writeFileSync(join(outside, "far.md"), "x");
    symlinkSync(outside, join(root, "entities", "linked"));
    expect(walkMarkdown(root, ["entities"])).toEqual(["entities/a.md"]);
  });
});

describe("noteView", () => {
  test("title precedence: frontmatter over H1 over basename", () => {
    const root = vault({
      "entities/fm.md": "---\ntitle: From Frontmatter\n---\n# Not This\nbody\n",
      "entities/h1.md": "prose first\n# The Heading\nmore\n",
      "entities/bare.md": "just prose\n",
    });
    expect(noteView(root, "entities/fm.md")?.title).toBe("From Frontmatter");
    expect(noteView(root, "entities/h1.md")?.title).toBe("The Heading");
    expect(noteView(root, "entities/bare.md")?.title).toBe("bare");
  });

  test("frontmatter parses off the body; mtime is ISO; unreadable → null", () => {
    const root = vault({
      "entities/n.md": "---\ntitle: T\ncategory: article\n---\nThe body.\n",
    });
    const v = noteView(root, "entities/n.md")!;
    expect(v.envelope.category).toBe("article");
    expect(v.body).toBe("The body.\n");
    expect(v.body).not.toContain("category:");
    expect(v.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(noteView(root, "entities/absent.md")).toBeNull();
  });
});

describe("excerpt", () => {
  test("headings and images drop; links unwrap to label or target#sub; markup strips", () => {
    expect(excerpt("# Heading\n![shot](a.png)\nProse about [[BigBrain]] and *emphasis*.\n")).toBe(
      "Prose about BigBrain and emphasis."
    );
    expect(excerpt("See [[entities/x|the label]] and [[page#Section]].")).toBe(
      "See the label and page#Section."
    );
    expect(excerpt("A [markdown link](http://x) survives as its text.")).toBe(
      "A markdown link survives as its text."
    );
  });

  test("whitespace collapses and long prose ellipsizes at max", () => {
    expect(excerpt("a\n\n  b\tc")).toBe("a b c");
    const long = "word ".repeat(100);
    const out = excerpt(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });
});
