import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalizeLinks,
  checkLinks,
  listNotes,
  migrateLinks,
  noteIndex,
  parseLinks,
  parseWikilinks,
  repairRenames,
  resolve,
  wikilinkText,
} from "../lib/links";
import { mdVault } from "./support/vault";

const vault = (files: Record<string, string>): string => mdVault({ prefix: "bb-links-", files });

describe("wrapped |labels — the editor hard-wraps prose, links must survive it", () => {
  const wrapped =
    "---\ntitle: A\n---\n\n" +
    "- [[2026-06-24-weekly-check-in|2026-06-24 —\n" +
    "  Simulated Question Bank check-in]] — weekly check-in notes.\n";

  test("parseLinks sees a link whose label spans a line break", () => {
    const root = vault({ "memory/a.md": wrapped });
    const links = parseLinks(root, "memory/a.md");
    expect(links).toHaveLength(1);
    expect(links[0]!.target).toBe("2026-06-24-weekly-check-in");
    // the wrapped label reads back as one line
    expect(links[0]!.label).toBe("2026-06-24 — Simulated Question Bank check-in");
    expect(links[0]!.line).toBe(5);
  });

  test("a wrapped citation RESOLVES — the bug that hid dossier→reference links", () => {
    const root = vault({
      "memory/a.md": wrapped,
      "references/2026-06-24-weekly-check-in.md":
        "---\nid: granola-1\ntitle: Weekly check-in\n---\n\nbody\n",
    });
    const idx = noteIndex([...listNotes(root), "references/2026-06-24-weekly-check-in.md"]);
    expect(resolve("2026-06-24-weekly-check-in", idx)).toEqual([
      "references/2026-06-24-weekly-check-in.md",
    ]);
  });

  test("a wrapped TARGET does not parse — targets are slugs and never wrap", () => {
    const root = vault({ "memory/a.md": "see [[some-\nnote]] here\n" });
    expect(parseLinks(root, "memory/a.md")).toEqual([]);
  });
});

describe("single-line behavior is unchanged", () => {
  test("target, #sub, and |label all come through, with 1-indexed lines", () => {
    const root = vault({
      "memory/n.md": "---\ntitle: N\n---\n\nsee [[other#heading|the label]] and [[plain]]\n",
    });
    const links = parseLinks(root, "memory/n.md");
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      target: "other",
      sub: "#heading",
      label: "the label",
      line: 5,
    });
    expect(links[1]).toMatchObject({ target: "plain", sub: "", label: null, line: 5 });
  });

  test("fenced code blocks are still skipped, and lines after them still number correctly", () => {
    const root = vault({
      "memory/n.md": "pre [[before]]\n```\n[[inside-fence]]\n```\npost [[after]]\n",
    });
    const links = parseLinks(root, "memory/n.md");
    expect(links.map((l) => l.target)).toEqual(["before", "after"]);
    expect(links.map((l) => l.line)).toEqual([1, 5]);
  });

  test("a label may not swallow a following link — only `]]` closes", () => {
    const root = vault({
      "memory/one.md": "[[a|x]] and [[b|y]]\n",
      "memory/two.md": "[[a|[x] y]] and [[b]]\n",
    });
    expect(parseLinks(root, "memory/one.md").map((l) => l.target)).toEqual(["a", "b"]);
    expect(parseLinks(root, "memory/two.md").map((l) => l.target)).toEqual(["a", "b"]);
  });
});

describe("parseWikilinks — the one parse lib/api.ts's chip list and excerpt share (#257)", () => {
  test("target and #sub come apart, unlike lib/api.ts's old fused copy", () => {
    const [link] = parseWikilinks("see [[memory/bigbrain#Some Heading]] here");
    expect(link).toMatchObject({ target: "memory/bigbrain", sub: "#Some Heading", label: null });
  });

  test("index/raw let a caller splice a replacement back into the source", () => {
    const text = "a [[x|X]] b [[y]] c";
    const [first, second] = parseWikilinks(text);
    expect(text.slice(first!.index, first!.index + first!.raw.length)).toBe("[[x|X]]");
    expect(text.slice(second!.index, second!.index + second!.raw.length)).toBe("[[y]]");
  });

  test("wikilinkText: the label if written, else target#sub", () => {
    const [labelled, anchored] = parseWikilinks("[[a|the label]] and [[b#heading]]");
    expect(wikilinkText(labelled!)).toBe("the label");
    expect(wikilinkText(anchored!)).toBe("b#heading");
  });
});

describe("bracketed |labels — a clipped title like “[PLDI'26] …” is a routine label (#234)", () => {
  // The live case from Dana's vault: the canonicalizer uses the clipped
  // paper's title as the label, brackets and all. Before the fix the label
  // class rejected `]`, so the link rendered as raw text and drew no edge.
  const logLine =
    "---\ntitle: Log\n---\n\n" +
    "- [[references/2026-08-12-pldi-26-compiling-strassen-like-matrix-multiplication-algori|" +
    "2026-08-12 — [PLDI'26] Compiling Strassen-like Matrix Multiplication Algorithms to Fast CUDA Kernels]]" +
    " — evaluated on NVIDIA A100.\n";

  test("parseLinks reads target and label through the inner brackets", () => {
    const root = vault({ "memory/log.md": logLine });
    const links = parseLinks(root, "memory/log.md");
    expect(links).toHaveLength(1);
    expect(links[0]!.target).toBe(
      "references/2026-08-12-pldi-26-compiling-strassen-like-matrix-multiplication-algori"
    );
    expect(links[0]!.label).toBe(
      "2026-08-12 — [PLDI'26] Compiling Strassen-like Matrix Multiplication Algorithms to Fast CUDA Kernels"
    );
  });

  test("the bracketed citation resolves to its reference", () => {
    const ref =
      "references/2026-08-12-pldi-26-compiling-strassen-like-matrix-multiplication-algori.md";
    const root = vault({
      "memory/log.md": logLine,
      [ref]: "---\nid: clip-1\ntitle: Compiling Strassen-like\n---\n\nbody\n",
    });
    const idx = noteIndex([...listNotes(root), ref]);
    const [link] = parseLinks(root, "memory/log.md");
    expect(resolve(link!.target, idx)).toEqual([ref]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// The memory boundary (Nick, 2026-08-05): "ingest NEVER links to memory
// notes. should not even see them. ONLY links to references. (memory
// notes can link to anything)". Structurally: memory/ is not in the
// wikilink target namespace — for anyone — so the record cannot come to
// depend on its own cache, and a memory topic sharing an entity's
// basename casts no shadow over it.
// ══════════════════════════════════════════════════════════════════════
describe("the memory boundary — memory/ is outside the wikilink namespace", () => {
  // The correction of 2026-08-06. The rule's own parenthetical — "memory
  // notes can link to anything" — includes each other; the first cut
  // severed that by amputating the namespace instead of policing the
  // direction. A memory topic is reachable, but only by saying so.
  test("memory → memory resolves when the target names its tree", () => {
    const root = vault({
      "memory/MEMORY.md": "# Memory index\n\n- [[memory/fri-work|FRI work]]\n",
      "memory/fri-work.md": "---\ntitle: FRI\n---\n\ntopic\n",
    });
    const r = checkLinks(root);
    expect(r.broken).toHaveLength(0);
    expect(r.boundary).toHaveLength(0);
    expect(r.unqualified).toHaveLength(0);
  });

  test("memory → memory by BARE name still misses — bare names live in the record", () => {
    const root = vault({
      "memory/MEMORY.md": "# Memory index\n\n- [[fri-work]]\n",
      "memory/fri-work.md": "---\ntitle: FRI\n---\n\ntopic\n",
    });
    const r = checkLinks(root);
    expect(r.broken.map((l) => l.target)).toEqual(["fri-work"]);
    expect(r.boundary).toHaveLength(0); // memory-authored: never a boundary crime
  });

});

// ══════════════════════════════════════════════════════════════════════
// Root-relative targets (2026-08-06) — Obsidian's "Absolute path in
// vault" format. A target names its tree, so a shared basename is no
// longer a guess, and the memory boundary becomes a direction instead of
// an amputated namespace.
// ══════════════════════════════════════════════════════════════════════
describe("root-relative links", () => {
  test("a path target matches EXACTLY from the root — a suffix is not a match", () => {
    const root = vault({
      "memory/people/foo.md": "---\ntitle: Foo\n---\n\nx\n",
      "memory/a.md": "---\ntitle: A\n---\n\n[[people/foo]] vs [[memory/people/foo]]\n",
    });
    const r = checkLinks(root);
    expect(r.broken.map((l) => l.target)).toEqual(["people/foo"]);
  });

  test("migrate qualifies a resolvable bare link, keeping what the reader saw", () => {
    const root = vault({
      "memory/nick.md":
        "---\ntitle: Nick\n---\n\nbuilds [[big-brain]] and [[big-brain|the product]]\n",
      "memory/big-brain.md": "---\ntitle: Big Brain\n---\n\nx\n",
    });
    const r = migrateLinks(root, true);
    expect(r.rewritten).toBe(2);
    expect(readFileSync(join(root, "memory/nick.md"), "utf8")).toContain(
      "builds [[memory/big-brain|big-brain]] and [[memory/big-brain|the product]]"
    );
  });

  test("migrate qualifies a link whose |label wraps a line break (the per-line scan skipped 162 of these)", () => {
    const root = vault({
      "memory/a.md":
        "---\ntitle: A\n---\n\n" +
        "- [[weekly-check-in|2026-06-24 —\n  Simulated Question Bank check-in]] — discussed X\n",
      "memory/weekly-check-in.md": "---\ntitle: Check-in\n---\n\nx\n",
    });
    expect(migrateLinks(root, true).rewritten).toBe(1);
    const after = readFileSync(join(root, "memory/a.md"), "utf8");
    expect(after).toContain(
      "[[memory/weekly-check-in|2026-06-24 —\n  Simulated Question Bank check-in]]"
    );
    expect(after).toContain("— discussed X"); // the prose after the link survives the splice
  });

  test("migrate keeps a hard wrap that falls right after the | — a rewrite must not join two lines", () => {
    const root = vault({
      "memory/a.md":
        "---\ntitle: A\n---\n\nasked [[kirsten-wharton|\nKirsten Wharton]] (misheard) about it\n",
      "memory/kirsten-wharton.md": "---\ntitle: Kirsten\n---\n\nx\n",
    });
    expect(migrateLinks(root, true).rewritten).toBe(1);
    expect(readFileSync(join(root, "memory/a.md"), "utf8")).toBe(
      "---\ntitle: A\n---\n\nasked [[memory/kirsten-wharton|\nKirsten Wharton]] (misheard) about it\n"
    );
  });

  test("migrate does not touch links inside a fenced block, and keeps the fence intact", () => {
    const root = vault({
      "memory/a.md": "---\ntitle: A\n---\n\n[[b]]\n\n```\n[[b]]\n```\n\ntail\n",
      "memory/b.md": "---\ntitle: B\n---\n\nx\n",
    });
    expect(migrateLinks(root, true).rewritten).toBe(1);
    expect(readFileSync(join(root, "memory/a.md"), "utf8")).toBe(
      "---\ntitle: A\n---\n\n[[memory/b|b]]\n\n```\n[[b]]\n```\n\ntail\n"
    );
  });

  test("migrate leaves an already-canonical link alone and reports nothing", () => {
    const root = vault({
      "memory/nick.md": "---\ntitle: Nick\n---\n\n[[memory/big-brain|Big Brain]]\n",
      "memory/big-brain.md": "---\ntitle: Big Brain\n---\n\nx\n",
    });
    expect(migrateLinks(root, true)).toMatchObject({
      rewritten: 0,
      filesTouched: 0,
      unmatched: [],
      contested: [],
    });
  });

  test("migrate qualifies the memory index's own topic links", () => {
    const root = vault({
      "memory/MEMORY.md": "# Memory index\n\n- [[fri-work|FRI work]]\n",
      "memory/fri-work.md": "---\ntitle: FRI\n---\n\ntopic\n",
    });
    // bare [[fri-work]] resolves to nothing (bare names live in the
    // record), so the date-stripped rescue path qualifies it
    migrateLinks(root, true);
    expect(readFileSync(join(root, "memory/MEMORY.md"), "utf8")).toContain(
      "[[memory/fri-work|FRI work]]"
    );
  });

  test("a markdown link to a note is reported — the graph cannot see it", () => {
    const root = vault({
      "memory/MEMORY.md": "# Memory index\n\n- [FRI work](fri-work.md) — load for research\n",
      "memory/fri-work.md": "---\ntitle: FRI\n---\n\ntopic\n",
    });
    const r = checkLinks(root);
    expect(r.markdown).toHaveLength(1);
    expect(r.markdown[0]).toMatchObject({
      file: "memory/MEMORY.md",
      href: "fri-work.md",
      label: "FRI work",
      resolved: "memory/fri-work.md", // relative to the LINKING note's directory
    });
    expect(checkLinks(root).broken).toHaveLength(0); // and it is not broken — just not a wikilink
  });

  test("markdown links to non-notes are left alone — URLs, anchors, assets, absent files", () => {
    const root = vault({
      "memory/a.md":
        "---\ntitle: A\n---\n\n" +
        "[site](https://example.com) [up](#heading) [pic](../img/x.png)\n" +
        "[gone](no-such-note.md) ![shot](b.md)\n",
      "memory/b.md": "---\ntitle: B\n---\n\nx\n",
    });
    expect(checkLinks(root).markdown).toHaveLength(0); // the ! makes the last one an image
  });

  test("migrate converts a markdown link to a wikilink, keeping the label", () => {
    const root = vault({
      "memory/MEMORY.md": "# Memory index\n\n- [FRI work](fri-work.md) — load for research\n",
      "memory/fri-work.md": "---\ntitle: FRI\n---\n\ntopic\n",
    });
    expect(migrateLinks(root, true).rewritten).toBe(1);
    expect(readFileSync(join(root, "memory/MEMORY.md"), "utf8")).toBe(
      "# Memory index\n\n- [[memory/fri-work|FRI work]] — load for research\n"
    );
    expect(checkLinks(root).markdown).toHaveLength(0); // now it is a wikilink
  });

  // The contract both commit paths lean on (lib/run/commit.ts,
  // bin/memory.ts): scope the WALK to what a run
  // wrote, resolve against the WHOLE vault.
  test("canonicalizeLinks walks only the given files but resolves against everything", () => {
    const root = vault({
      "memory/touched.md": "---\ntitle: T\n---\n\n[[ada-lovelace|Ada]]\n",
      "memory/untouched.md": "---\ntitle: U\n---\n\n[[ada-lovelace|Ada]]\n",
      "memory/ada-lovelace.md": "---\ntitle: Ada\n---\n\nx\n",
    });
    const res = canonicalizeLinks(root, ["memory/touched.md"], true);
    expect(res).toMatchObject({ rewritten: 1, filesTouched: 1 });
    expect(readFileSync(join(root, "memory/touched.md"), "utf8")).toContain(
      "[[memory/ada-lovelace|Ada]]"
    );
    expect(readFileSync(join(root, "memory/untouched.md"), "utf8")).toContain(
      "[[ada-lovelace|Ada]]"
    );
  });

  test("canonicalizeLinks survives a file deleted mid-run", () => {
    const root = vault({ "memory/a.md": "---\ntitle: A\n---\n\nx\n" });
    expect(() =>
      canonicalizeLinks(root, ["memory/a.md", "memory/gone.md"], true)
    ).not.toThrow();
  });

});

// ══════════════════════════════════════════════════════════════════════
// Backlink repair on rename/move (#52). Path identity is the price of
// Obsidian-legal links; this is what pays it.
// ══════════════════════════════════════════════════════════════════════
describe("repairRenames", () => {
  test("a MOVE is followed through a path link — the case bare basenames used to survive", () => {
    const root = vault({
      "memory/people/ada.md": "---\ntitle: Ada\n---\n\nmoved here\n",
      "memory/citing.md": "---\ntitle: C\n---\n\nsee [[memory/ada|Ada]]\n",
    });
    const res = repairRenames(
      root,
      [{ from: "memory/ada.md", to: "memory/people/ada.md" }],
      true
    );
    expect(res).toMatchObject({ rewritten: 1, filesTouched: 1 });
    expect(readFileSync(join(root, "memory/citing.md"), "utf8")).toContain(
      "[[memory/people/ada|Ada]]"
    );
  });

  test("a RENAME is followed through a bare link when nothing else answers to the old name", () => {
    const root = vault({
      "memory/ada-lovelace.md": "---\ntitle: Ada\n---\n\nrenamed\n",
      "memory/citing.md": "---\ntitle: C\n---\n\nsee [[ada]] and [[ada|the countess]]\n",
    });
    const res = repairRenames(
      root,
      [{ from: "memory/ada.md", to: "memory/ada-lovelace.md" }],
      true
    );
    expect(res.rewritten).toBe(2);
    const body = readFileSync(join(root, "memory/citing.md"), "utf8");
    expect(body).toContain("[[memory/ada-lovelace|ada]]"); // display preserved
    expect(body).toContain("[[memory/ada-lovelace|the countess]]");
  });

  test("a bare link is LEFT ALONE when a surviving note still answers to the old name", () => {
    const root = vault({
      "memory/ada-lovelace.md": "---\ntitle: Ada\n---\n\nrenamed\n",
      "memory/people/ada.md": "---\ntitle: another ada\n---\n\nstill here\n",
      "memory/citing.md": "---\ntitle: C\n---\n\nsee [[ada]]\n",
    });
    const res = repairRenames(
      root,
      [{ from: "memory/ada.md", to: "memory/ada-lovelace.md" }],
      true
    );
    expect(res.rewritten).toBe(0);
    expect(res.contested.map((l) => l.target)).toEqual(["ada"]);
    expect(readFileSync(join(root, "memory/citing.md"), "utf8")).toContain("[[ada]]");
  });

  test("links to notes that did not move are untouched, and no renames is a no-op", () => {
    const root = vault({
      "memory/a.md": "---\ntitle: A\n---\n\n[[memory/b|B]]\n",
      "memory/b.md": "---\ntitle: B\n---\n\nx\n",
    });
    expect(repairRenames(root, [], true)).toMatchObject({ rewritten: 0, filesTouched: 0 });
    expect(
      repairRenames(root, [{ from: "memory/z.md", to: "memory/y.md" }], true).rewritten
    ).toBe(0);
    expect(readFileSync(join(root, "memory/a.md"), "utf8")).toContain("[[memory/b|B]]");
  });

  test("a wrapped label survives the follow, and fenced code is not rewritten", () => {
    const root = vault({
      "memory/new.md": "---\ntitle: N\n---\n\nx\n",
      "memory/citing.md":
        "---\ntitle: C\n---\n\n[[memory/old|the\n  long name]] here\n\n```\n[[memory/old]]\n```\n",
    });
    repairRenames(root, [{ from: "memory/old.md", to: "memory/new.md" }], true);
    const body = readFileSync(join(root, "memory/citing.md"), "utf8");
    expect(body).toContain("[[memory/new|the\n  long name]]");
    expect(body).toContain("```\n[[memory/old]]\n```"); // code left alone
  });
});
