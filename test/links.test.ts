import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { landReference } from "../lib/references";
import {
  canonicalizeLinks,
  checkLinks,
  checkSources,
  checkTypes,
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
    const root = vault({ "entities/a.md": wrapped });
    const links = parseLinks(root, "entities/a.md");
    expect(links).toHaveLength(1);
    expect(links[0]!.target).toBe("2026-06-24-weekly-check-in");
    // the wrapped label reads back as one line
    expect(links[0]!.label).toBe("2026-06-24 — Simulated Question Bank check-in");
    expect(links[0]!.line).toBe(5);
  });

  test("a wrapped citation RESOLVES — the bug that hid dossier→reference links", () => {
    const root = vault({
      "entities/a.md": wrapped,
      "references/2026-06-24-weekly-check-in.md":
        "---\nid: granola-1\ntitle: Weekly check-in\n---\n\nbody\n",
    });
    const idx = noteIndex([...listNotes(root), "references/2026-06-24-weekly-check-in.md"]);
    expect(resolve("2026-06-24-weekly-check-in", idx)).toEqual([
      "references/2026-06-24-weekly-check-in.md",
    ]);
  });

  test("a wrapped TARGET does not parse — targets are slugs and never wrap", () => {
    const root = vault({ "entities/a.md": "see [[some-\nnote]] here\n" });
    expect(parseLinks(root, "entities/a.md")).toEqual([]);
  });
});

describe("single-line behavior is unchanged", () => {
  test("target, #sub, and |label all come through, with 1-indexed lines", () => {
    const root = vault({
      "entities/n.md": "---\ntitle: N\n---\n\nsee [[other#heading|the label]] and [[plain]]\n",
    });
    const links = parseLinks(root, "entities/n.md");
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
      "entities/n.md": "pre [[before]]\n```\n[[inside-fence]]\n```\npost [[after]]\n",
    });
    const links = parseLinks(root, "entities/n.md");
    expect(links.map((l) => l.target)).toEqual(["before", "after"]);
    expect(links.map((l) => l.line)).toEqual([1, 5]);
  });

  test("a label may not swallow a following link — only `]]` closes", () => {
    const root = vault({
      "entities/one.md": "[[a|x]] and [[b|y]]\n",
      "entities/two.md": "[[a|[x] y]] and [[b]]\n",
    });
    expect(parseLinks(root, "entities/one.md").map((l) => l.target)).toEqual(["a", "b"]);
    expect(parseLinks(root, "entities/two.md").map((l) => l.target)).toEqual(["a", "b"]);
  });
});

describe("parseWikilinks — the one parse lib/api.ts's chip list and excerpt share (#257)", () => {
  test("target and #sub come apart, unlike lib/api.ts's old fused copy", () => {
    const [link] = parseWikilinks("see [[entities/bigbrain#Some Heading]] here");
    expect(link).toMatchObject({ target: "entities/bigbrain", sub: "#Some Heading", label: null });
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
    const root = vault({ "entities/log.md": logLine });
    const links = parseLinks(root, "entities/log.md");
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
      "entities/log.md": logLine,
      [ref]: "---\nid: clip-1\ntitle: Compiling Strassen-like\n---\n\nbody\n",
    });
    const idx = noteIndex([...listNotes(root), ref]);
    const [link] = parseLinks(root, "entities/log.md");
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
  test("a record link aimed at a memory-only basename is a BOUNDARY violation, not merely broken", () => {
    const root = vault({
      "entities/nick.md": "---\ntitle: Nick\n---\n\nsee [[fri-work]]\n",
      "memory/fri-work.md": "---\ntitle: FRI work\n---\n\ntopic\n",
    });
    const r = checkLinks(root);
    expect(r.boundary).toHaveLength(1);
    expect(r.boundary[0]).toMatchObject({ file: "entities/nick.md", target: "fri-work" });
    expect(r.broken).toHaveLength(0);
  });

  test("a basename collision resolves to the ENTITY alone — memory's shadow casts no ambiguity (the live big-brain case)", () => {
    const root = vault({
      "entities/big-brain.md": "---\ntitle: Big Brain\n---\n\ndossier\n",
      "memory/big-brain.md": "---\ntitle: Big Brain topic\n---\n\ntopic citing [[big-brain]]\n",
      "entities/nick.md": "---\ntitle: Nick\n---\n\nbuilds [[big-brain]]\n",
    });
    const r = checkLinks(root);
    expect(r.ambiguous).toHaveLength(0);
    expect(r.boundary).toHaveLength(0);
    expect(r.broken).toHaveLength(0);
  });

  test("memory notes link OUT freely and their links are still checked", () => {
    const root = vault({
      "entities/evan-keller.md": "---\ntitle: Evan Keller\n---\n\nx\n",
      "memory/fri-work.md": "---\ntitle: FRI\n---\n\nmanaged by [[evan-keller]], and [[nobody]]\n",
    });
    const r = checkLinks(root);
    expect(r.broken.map((l) => l.target)).toEqual(["nobody"]);
    expect(r.boundary).toHaveLength(0);
  });

  test("an explicit memory/ path link is boundary; a record sources: ref into memory/ is unresolved (cache is not evidence)", () => {
    const root = vault({
      "entities/nick.md":
        "---\ntitle: Nick\nsources:\n  - memory/fri-work.md\n---\n\nsee [[memory/fri-work]]\n",
      "memory/fri-work.md": "---\ntitle: FRI\n---\n\ntopic\n",
    });
    expect(checkLinks(root).boundary).toHaveLength(1);
    expect(checkSources(root).unresolved).toEqual([
      { file: "entities/nick.md", ref: "memory/fri-work.md" },
    ]);
  });

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

  test("the live big-brain collision, both ways: bare is the entity, path is the topic", () => {
    const root = vault({
      "entities/big-brain.md": "---\ntitle: Big Brain\n---\n\ndossier\n",
      "memory/big-brain.md": "---\ntitle: topic\n---\n\n[[big-brain]] and [[memory/big-brain]]\n",
    });
    const idx = noteIndex(listNotes(root));
    expect(resolve("big-brain", idx)).toEqual(["entities/big-brain.md"]); // bare: the entity
    expect(resolve("memory/big-brain", idx)).toEqual(["memory/big-brain.md"]); // path: the topic
    expect(checkLinks(root).ambiguous).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Root-relative targets (2026-08-06) — Obsidian's "Absolute path in
// vault" format. A target names its tree, so a shared basename is no
// longer a guess, and the memory boundary becomes a direction instead of
// an amputated namespace.
// ══════════════════════════════════════════════════════════════════════
describe("root-relative links", () => {
  test("a bare target is `unqualified` — it still resolves, so a mid-migration vault does not go dark", () => {
    const root = vault({
      "entities/a.md": "---\ntitle: A\n---\n\n[[b]] and [[entities/b]]\n",
      "entities/b.md": "---\ntitle: B\n---\n\nx\n",
    });
    const r = checkLinks(root);
    expect(r.unqualified.map((l) => l.target)).toEqual(["b"]);
    expect(r.broken).toHaveLength(0); // both resolve; only one is canonical
  });

  test("a path target matches EXACTLY from the root — a suffix is not a match", () => {
    const root = vault({
      "entities/people/foo.md": "---\ntitle: Foo\n---\n\nx\n",
      "entities/a.md": "---\ntitle: A\n---\n\n[[people/foo]] vs [[entities/people/foo]]\n",
    });
    const r = checkLinks(root);
    expect(r.broken.map((l) => l.target)).toEqual(["people/foo"]);
  });

  test("migrate qualifies a resolvable bare link, keeping what the reader saw", () => {
    const root = vault({
      "entities/nick.md":
        "---\ntitle: Nick\n---\n\nbuilds [[big-brain]] and [[big-brain|the product]]\n",
      "entities/big-brain.md": "---\ntitle: Big Brain\n---\n\nx\n",
    });
    const r = migrateLinks(root, true);
    expect(r.rewritten).toBe(2);
    expect(readFileSync(join(root, "entities/nick.md"), "utf8")).toContain(
      "builds [[entities/big-brain|big-brain]] and [[entities/big-brain|the product]]"
    );
  });

  test("migrate qualifies a link whose |label wraps a line break (the per-line scan skipped 162 of these)", () => {
    const root = vault({
      "entities/a.md":
        "---\ntitle: A\n---\n\n" +
        "- [[2026-06-24-weekly-check-in|2026-06-24 —\n  Simulated Question Bank check-in]] — discussed X\n",
      "entities/2026-06-24-weekly-check-in.md": "---\ntitle: Check-in\n---\n\nx\n",
    });
    expect(migrateLinks(root, true).rewritten).toBe(1);
    const after = readFileSync(join(root, "entities/a.md"), "utf8");
    expect(after).toContain(
      "[[entities/2026-06-24-weekly-check-in|2026-06-24 —\n  Simulated Question Bank check-in]]"
    );
    expect(after).toContain("— discussed X"); // the prose after the link survives the splice
  });

  test("migrate keeps a hard wrap that falls right after the | — a rewrite must not join two lines", () => {
    const root = vault({
      "entities/a.md":
        "---\ntitle: A\n---\n\nasked [[kirsten-wharton|\nKirsten Wharton]] (misheard) about it\n",
      "entities/kirsten-wharton.md": "---\ntitle: Kirsten\n---\n\nx\n",
    });
    expect(migrateLinks(root, true).rewritten).toBe(1);
    expect(readFileSync(join(root, "entities/a.md"), "utf8")).toBe(
      "---\ntitle: A\n---\n\nasked [[entities/kirsten-wharton|\nKirsten Wharton]] (misheard) about it\n"
    );
  });

  test("migrate does not touch links inside a fenced block, and keeps the fence intact", () => {
    const root = vault({
      "entities/a.md": "---\ntitle: A\n---\n\n[[b]]\n\n```\n[[b]]\n```\n\ntail\n",
      "entities/b.md": "---\ntitle: B\n---\n\nx\n",
    });
    expect(migrateLinks(root, true).rewritten).toBe(1);
    expect(readFileSync(join(root, "entities/a.md"), "utf8")).toBe(
      "---\ntitle: A\n---\n\n[[entities/b|b]]\n\n```\n[[b]]\n```\n\ntail\n"
    );
  });

  test("migrate leaves an already-canonical link alone and reports nothing", () => {
    const root = vault({
      "entities/nick.md": "---\ntitle: Nick\n---\n\n[[entities/big-brain|Big Brain]]\n",
      "entities/big-brain.md": "---\ntitle: Big Brain\n---\n\nx\n",
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
      "entities/a.md":
        "---\ntitle: A\n---\n\n" +
        "[site](https://example.com) [up](#heading) [pic](../img/x.png)\n" +
        "[gone](no-such-note.md) ![shot](b.md)\n",
      "entities/b.md": "---\ntitle: B\n---\n\nx\n",
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
      "entities/touched.md": "---\ntitle: T\n---\n\n[[ada-lovelace|Ada]]\n",
      "entities/untouched.md": "---\ntitle: U\n---\n\n[[ada-lovelace|Ada]]\n",
      "entities/ada-lovelace.md": "---\ntitle: Ada\n---\n\nx\n",
    });
    const res = canonicalizeLinks(root, ["entities/touched.md"], true);
    expect(res).toMatchObject({ rewritten: 1, filesTouched: 1 });
    expect(readFileSync(join(root, "entities/touched.md"), "utf8")).toContain(
      "[[entities/ada-lovelace|Ada]]"
    );
    expect(readFileSync(join(root, "entities/untouched.md"), "utf8")).toContain(
      "[[ada-lovelace|Ada]]"
    );
  });

  test("canonicalizeLinks survives a file deleted mid-run", () => {
    const root = vault({ "entities/a.md": "---\ntitle: A\n---\n\nx\n" });
    expect(() =>
      canonicalizeLinks(root, ["entities/a.md", "entities/gone.md"], true)
    ).not.toThrow();
  });

  test("a bare colliding name resolves to the entity alone — never the memory topic", () => {
    const root = vault({
      "entities/big-brain.md": "---\ntitle: Big Brain\n---\n\nx\n",
      "memory/big-brain.md": "---\ntitle: topic\n---\n\nx\n",
      "entities/nick.md": "---\ntitle: Nick\n---\n\nbuilds [[big-brain]]\n",
    });
    expect(resolve("big-brain", noteIndex(listNotes(root)))).toEqual(["entities/big-brain.md"]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Backlink repair on rename/move (#52). Path identity is the price of
// Obsidian-legal links; this is what pays it.
// ══════════════════════════════════════════════════════════════════════
describe("repairRenames", () => {
  test("a MOVE is followed through a path link — the case bare basenames used to survive", () => {
    const root = vault({
      "entities/people/ada.md": "---\ntitle: Ada\n---\n\nmoved here\n",
      "entities/citing.md": "---\ntitle: C\n---\n\nsee [[entities/ada|Ada]]\n",
    });
    const res = repairRenames(
      root,
      [{ from: "entities/ada.md", to: "entities/people/ada.md" }],
      true
    );
    expect(res).toMatchObject({ rewritten: 1, filesTouched: 1 });
    expect(readFileSync(join(root, "entities/citing.md"), "utf8")).toContain(
      "[[entities/people/ada|Ada]]"
    );
  });

  test("a RENAME is followed through a bare link when nothing else answers to the old name", () => {
    const root = vault({
      "entities/ada-lovelace.md": "---\ntitle: Ada\n---\n\nrenamed\n",
      "entities/citing.md": "---\ntitle: C\n---\n\nsee [[ada]] and [[ada|the countess]]\n",
    });
    const res = repairRenames(
      root,
      [{ from: "entities/ada.md", to: "entities/ada-lovelace.md" }],
      true
    );
    expect(res.rewritten).toBe(2);
    const body = readFileSync(join(root, "entities/citing.md"), "utf8");
    expect(body).toContain("[[entities/ada-lovelace|ada]]"); // display preserved
    expect(body).toContain("[[entities/ada-lovelace|the countess]]");
  });

  test("a bare link is LEFT ALONE when a surviving note still answers to the old name", () => {
    const root = vault({
      "entities/ada-lovelace.md": "---\ntitle: Ada\n---\n\nrenamed\n",
      "entities/people/ada.md": "---\ntitle: another ada\n---\n\nstill here\n",
      "entities/citing.md": "---\ntitle: C\n---\n\nsee [[ada]]\n",
    });
    const res = repairRenames(
      root,
      [{ from: "entities/ada.md", to: "entities/ada-lovelace.md" }],
      true
    );
    expect(res.rewritten).toBe(0);
    expect(res.contested.map((l) => l.target)).toEqual(["ada"]);
    expect(readFileSync(join(root, "entities/citing.md"), "utf8")).toContain("[[ada]]");
  });

  test("links to notes that did not move are untouched, and no renames is a no-op", () => {
    const root = vault({
      "entities/a.md": "---\ntitle: A\n---\n\n[[entities/b|B]]\n",
      "entities/b.md": "---\ntitle: B\n---\n\nx\n",
    });
    expect(repairRenames(root, [], true)).toMatchObject({ rewritten: 0, filesTouched: 0 });
    expect(
      repairRenames(root, [{ from: "entities/z.md", to: "entities/y.md" }], true).rewritten
    ).toBe(0);
    expect(readFileSync(join(root, "entities/a.md"), "utf8")).toContain("[[entities/b|B]]");
  });

  test("a wrapped label survives the follow, and fenced code is not rewritten", () => {
    const root = vault({
      "entities/new.md": "---\ntitle: N\n---\n\nx\n",
      "entities/citing.md":
        "---\ntitle: C\n---\n\n[[entities/old|the\n  long name]] here\n\n```\n[[entities/old]]\n```\n",
    });
    repairRenames(root, [{ from: "entities/old.md", to: "entities/new.md" }], true);
    const body = readFileSync(join(root, "entities/citing.md"), "utf8");
    expect(body).toContain("[[entities/new|the\n  long name]]");
    expect(body).toContain("```\n[[entities/old]]\n```"); // code left alone
  });
});

describe("checkTypes — the type vocabulary (reference | entity | memory-by-tree; note retired 2026-08-05)", () => {
  test("a clean vault: stamped references, typed entities, silent memory", () => {
    const root = vault({
      "references/2026-08-05-a.md":
        "---\nid: r-1\ntype: reference\ncategory: transcript\n---\n\nbody\n",
      "entities/ada-lovelace.md": "---\ntype: entity\nentity_type: person\n---\n\nAda.\n",
      "memory/MEMORY.md": "# Memory index\n", // no frontmatter — tree-typed, never checked
    });
    const r = checkTypes(root);
    expect(r.checked).toBe(2);
    expect(r.violations).toEqual([]);
  });

  test("a retired or foreign type in the record is a violation", () => {
    const root = vault({
      "references/2026-08-05-stray.md": "---\nid: n-1\ntype: note\ncategory: note\n---\n\nwords\n",
      "entities/thing.md": "---\ntype: reference\n---\n\nwrong tree\n",
    });
    const r = checkTypes(root);
    expect(r.violations).toEqual([
      { file: "references/2026-08-05-stray.md", declared: "note", expected: "reference" },
      { file: "entities/thing.md", declared: "reference", expected: "entity" },
    ]);
  });

  test("machinery in the record: a kind: request reference is flagged even when its type: looks right", () => {
    const root = vault({
      "references/2026-08-05-req.md":
        "---\nid: q-1\ntype: reference\nkind: request\ncategory: request\n---\n\nplease merge\n",
    });
    const r = checkTypes(root);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.declared).toBe("kind: request");
  });

  test("a pre-stamp reference with no type: at all is grandfathered; a typeless entity is not", () => {
    const root = vault({
      "references/2026-08-05-old.md": "---\nid: o-1\ncategory: legacy\n---\n\nlegacy\n",
      "entities/untyped.md": "---\naliases: [thing]\n---\n\nno type\n",
    });
    const r = checkTypes(root);
    expect(r.violations).toEqual([
      { file: "entities/untyped.md", declared: "(none)", expected: "entity" },
    ]);
  });

  test("entity_type outside ENTITY_TYPES (the SSOT) is a violation; absent is tolerated; references never checked for it", () => {
    const root = vault({
      "entities/acme.md": "---\ntype: entity\nentity_type: organization\n---\n\nshould be org\n",
      "entities/no-et.md": "---\ntype: entity\n---\n\nno entity_type — fine\n",
      "references/2026-08-05-r.md":
        "---\nid: r-1\ntype: reference\nentity_type: whatever\ncategory: paper\n---\n\nnot a dossier\n",
    });
    const r = checkTypes(root);
    expect(r.violations).toEqual([
      {
        file: "entities/acme.md",
        declared: "entity_type: organization",
        expected: "person | org | project | place",
      },
    ]);
  });
});

describe("checkTypes — the ONE reference category (Nick's rule, 2026-08-05)", () => {
  const CAT_EXPECTED = "exactly one category — stamped at landing, editor-reassignable";

  test("a missing or empty category on a reference is a violation; entities are never checked for it", () => {
    const root = vault({
      "references/2026-08-05-empty.md":
        "---\nid: c-2\ntype: reference\ncategory: ''\n---\n\nempty\n",
      "references/2026-08-05-none.md": "---\nid: c-1\ntype: reference\n---\n\nno category\n",
      "entities/fine.md": "---\ntype: entity\nentity_type: person\n---\n\nno category — fine\n",
    });
    const r = checkTypes(root);
    expect(r.violations).toEqual([
      {
        file: "references/2026-08-05-empty.md",
        declared: "category: (none)",
        expected: CAT_EXPECTED,
      },
      {
        file: "references/2026-08-05-none.md",
        declared: "category: (none)",
        expected: CAT_EXPECTED,
      },
    ]);
  });

  test("a list is not ONE category", () => {
    const root = vault({
      "references/2026-08-05-multi.md":
        "---\nid: c-3\ntype: reference\ncategory: [labs, pdf-import]\n---\n\ntwo words\n",
    });
    const r = checkTypes(root);
    expect(r.violations).toEqual([
      {
        file: "references/2026-08-05-multi.md",
        declared: "category: (a list)",
        expected: CAT_EXPECTED,
      },
    ]);
  });

  test("a landing writes no markdown for the check to sweep (#496)", () => {
    // Pre-#496 this pinned that landReference's own type/category stamp
    // passed checkTypes. The landing now writes only the insertion event;
    // checkTypes covers the frozen markdown record, which a landing no
    // longer grows.
    const root = vault({});
    landReference(root, "---\nkind: transcript\n---\n\nwords\n");
    const r = checkTypes(root);
    expect(r.checked).toBe(0);
    expect(r.violations).toEqual([]);
  });
});
