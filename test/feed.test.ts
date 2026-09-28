import { agentModelLabel, tagLabel } from "../web/ui/src/lib/feed";
import { describe, expect, test } from "bun:test";
import {
  visibleInRecents,
  accentIndex,
  chipBg,
  filedByLabel,
  filedByTitle,
  filerAllows,
  filerChips,
  hiddenFilerNodeIds,
  isReference,
  nestNotes,
  noteLabel,
  offFilers,
  filedMark,
} from "../web/ui/src/lib/feed";
import type { RecentEntry } from "../web/ui/src/lib/types";

describe("filedMark", () => {
  // Nick, 2026-08-13: the shared FilingStatus union carries "record", and
  // the UI renders it neutrally rather than narrowing the union back down.
  test("filed and declined both read as done, with the editor's own label", () => {
    expect(filedMark({ status: "filed" })).toEqual({
      done: true,
      label: "filed — the record cites it",
    });
    expect(filedMark({ status: "declined" })).toEqual({
      done: true,
      label: "filed — the record cites it",
    });
  });
  test('record is done too, but never wears the editor\'s "triaged" claim', () => {
    expect(filedMark({ status: "record" })).toEqual({
      done: true,
      label: "a record — nothing to file",
    });
  });
  test("pending — or no status yet — still waits", () => {
    expect(filedMark({ status: "pending" })).toEqual({ done: false, label: "not filed yet" });
    expect(filedMark({})).toEqual({ done: false, label: "not filed yet" });
  });
});

describe("Recents visibility", () => {
  test("only Pilot is omitted; status and provider do not hide other arrivals", () => {
    expect(visibleInRecents({ source: "pilot" })).toBe(false);
    expect(visibleInRecents({ from: "pilot" })).toBe(false);
    expect(visibleInRecents({ via: "pilot" })).toBe(false);
    for (const source of ["email", "agent-chat", "granola", "browser-extension"])
      for (const status of ["declined", "filed", "pending", "record"] as const)
        expect(visibleInRecents(row({ path: "references/item.md", modified: 1, source, status, from: "claude-code" }))).toBe(true);
  });
});

describe("accentIndex", () => {
  test("deterministic: the same key always lands on the same accent", () => {
    expect(accentIndex("granola")).toBe(accentIndex("granola"));
    expect(accentIndex("finance")).toBe(accentIndex("finance"));
  });
  test("always one of the five token accents", () => {
    for (const k of ["granola", "web extension", "you", "finance", "dreams", "fri", "a", "zz"]) {
      const n = accentIndex(k);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(5);
    }
  });
  test("case- and padding-insensitive: 'Granola ' is the same filer as 'granola'", () => {
    expect(accentIndex("Granola ")).toBe(accentIndex("granola"));
  });
  test("an empty key gets 0 — the neutral chip, not a stolen accent", () => {
    expect(accentIndex("")).toBe(0);
    expect(accentIndex("  ")).toBe(0);
  });
  test("different keys spread across more than one accent", () => {
    const seen = new Set(
      ["granola", "web extension", "you", "finance", "dreams", "fri", "research"].map(accentIndex)
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("chipBg", () => {
  test("an accent index mixes that accent into the page background", () => {
    expect(chipBg(3)).toBe("color-mix(in oklab, var(--accent-3) 24%, var(--bg))");
  });
  test("0 (and anything out of range) falls back to the neutral fill", () => {
    expect(chipBg(0)).toBe("var(--chip-neutral)");
    expect(chipBg(6)).toBe("var(--chip-neutral)");
  });
});

describe("filedByTitle — the model-id parse, through its one live door", () => {
  test("agent chips show the declared composer, never the gardener's model", () => {
    expect(filedByTitle({ via: "codex", band: "agent", from: "Codex (GPT-6)", filedModel: "claude-haiku-4-5" }))
      .toBe("Filed by codex — Codex (GPT-6)");
    expect(filedByTitle({ via: "claude code", band: "agent", from: "Claude Opus 5 (Claude Code)" }))
      .toBe("Filed by claude code — Claude Opus 5 (Claude Code)");
    expect(filedByTitle({ via: "codex", from: "nick@example.com", band: "person" })).toBe("Filed by codex");
    expect(filedByTitle({ via: "codex", filedModel: "claude-haiku-4-5" })).toBe("Filed by codex");
    expect(filedByTitle({ via: "codex", from: "Codex", band: "agent" })).toBe("Filed by codex");
  });

  // modelLabel went module-private with #260; its behavior is pinned here,
  // where the chip tooltip actually renders it.
  test("current-era ids read family + version", () => {
    expect(filedByTitle({ filedModel: "claude-haiku-4-5" })).toBe("Filed by BigBrain (haiku 4.5)");
    expect(filedByTitle({ filedModel: "claude-sonnet-4-5-20250929" })).toBe(
      "Filed by BigBrain (sonnet 4.5)"
    );
    expect(filedByTitle({ filedModel: "claude-opus-4-20250514" })).toBe(
      "Filed by BigBrain (opus 4)"
    );
  });
  test("version-first legacy ids parse too", () => {
    expect(filedByTitle({ filedModel: "claude-3-5-sonnet-20241022" })).toBe(
      "Filed by BigBrain (sonnet 3.5)"
    );
  });
  test("a bare family alias stays the family", () => {
    expect(filedByTitle({ filedModel: "claude-fable-5" })).toBe("Filed by BigBrain (fable 5)");
  });
  test("an unrecognized id is shown verbatim, never invented", () => {
    expect(filedByTitle({ filedModel: "my-fine-tune-v2" })).toBe(
      "Filed by BigBrain (my-fine-tune-v2)"
    );
  });
  test("no resolved model → no tooltip at all", () => {
    expect(filedByTitle({})).toBe("");
    expect(filedByTitle({ filedModel: " " })).toBe("");
  });
});

describe("filedByLabel", () => {
  test("the intake token / integration name (submitted_via) wins, deslugged", () => {
    expect(filedByLabel({ via: "web-extension", from: "nick@x.com", source: "web" })).toBe(
      "web extension"
    );
    expect(filedByLabel({ via: "granola", source: "granola" })).toBe("granola");
  });
  test("then the principal: an email collapses to its first name-ish segment", () => {
    expect(filedByLabel({ from: "alpha@example.com", source: "email" })).toBe("alpha");
    expect(filedByLabel({ from: "nick" })).toBe("nick");
  });
  test("then the channel, mapped to its friendly label", () => {
    // the app's drop zone reads as what it is to the person (2026-08-27),
    // whether the row carries the channel or a native `via`
    expect(filedByLabel({ source: "web" })).toBe("dropped");
    expect(filedByLabel({ via: "web" })).toBe("dropped");
    expect(filedByLabel({ via: "dropped" })).toBe("dropped");
    expect(filedByLabel({ source: "api" })).toBe("api");
    expect(filedByLabel({ source: "claude-code" })).toBe("claude code");
    expect(filedByLabel({ source: "email" })).toBe("email");
    expect(filedByLabel({ source: "that-tracks" })).toBe("that tracks");
  });
  test("a from that IS a channel name maps the same way", () => {
    expect(filedByLabel({ from: "claude-code", source: "claude-code" })).toBe("claude code");
  });
  test("machine work wears the product name — the exact model stays in the tooltip/journal", () => {
    expect(filedByLabel({ filedModel: "claude-haiku-4-5" })).toBe("BigBrain");
    expect(filedByLabel({ author: "editor" })).toBe("BigBrain"); // editor-authored row, journal unresolved
    expect(filedByLabel({ author: "intake" })).toBe(""); // an unfiled drop is not the machine's work
  });
  test("internal personas NEVER surface, from any field — the cell stays empty instead", () => {
    for (const persona of [
      "triage",
      "deep",
      "intake",
      "runner",
      "config",
      "vault-clean",
      "librarian",
    ]) {
      expect(filedByLabel({ via: persona })).toBe("");
      expect(filedByLabel({ from: persona })).toBe("");
      expect(filedByLabel({ source: persona })).toBe("");
    }
  });
  test("a persona in one field never blocks a real filer in the next", () => {
    expect(filedByLabel({ via: "triage", from: "nick@x.com" })).toBe("nick");
    expect(filedByLabel({ from: "intake", source: "granola" })).toBe("granola");
  });
  test("nothing resolvable → empty, never a fabricated label", () => {
    expect(filedByLabel({})).toBe("");
    expect(filedByLabel({ via: " ", from: "", source: undefined })).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════════
// nestNotes — a note folds under the thing it is a note ON. Both front
// doors already wrote the link (web drop: `about: <id>`; browser
// extension: a shared `url:`); until now nothing read it, so the feed
// showed "Note on: X" directly above "X".
// ══════════════════════════════════════════════════════════════════════
const row = (o: Partial<RecentEntry> & { path: string; modified: number }): RecentEntry =>
  ({ author: "intake", action: "added", band: "person", ...o }) as RecentEntry;

describe("isReference — the recent feed's one substrate (2026-08-10)", () => {
  test("keeps reference rows whether filed or still pending", () => {
    expect(
      isReference(row({ path: "references/a.md", modified: 1, type: "reference", status: "filed" }))
    ).toBe(true);
    expect(
      isReference(
        row({ path: "references/b.md", modified: 1, type: "reference", status: "pending" })
      )
    ).toBe(true);
  });
  test("keeps native source-log rows", () => {
    expect(isReference(row({
      path: "log/insertions/2026-08/ins_0123456789abcdef01234567.json",
      modified: 1, type: "source", status: "record",
    }))).toBe(true);
  });
  test("a note IS a reference — annotations keep nesting under what they annotate", () => {
    expect(
      isReference(
        row({ path: "references/note.md", modified: 1, type: "reference", category: "annotation" })
      )
    ).toBe(true);
  });
  test("drops entity dossiers — the editor's compression, not an arrival", () => {
    expect(
      isReference(
        row({ path: "entities/ada-lovelace.md", modified: 1, type: "entity", entity: true })
      )
    ).toBe(false);
  });
  test("drops the typeless git-reconstructed rows: memory sweeps, dossier edits, pre-envelope history", () => {
    for (const path of [
      "memory/MEMORY.md",
      "entities/nick.md",
      "domains/finance/note.md",
      "library/granola/x.md",
    ])
      expect(isReference(row({ path, modified: 1 }))).toBe(false);
  });
});

describe("nestNotes", () => {
  // Invented capture/annotation pair: two seconds apart, one URL.
  const clip = row({
    path: "references/2026-01-01-seasonal-sensor-guide.md",
    modified: 1_000,
    id: "demo-capture-1",
    title: "Seasonal Sensor Guide",
    url: "https://example.com/sensor-guide",
    category: "web-clip",
    tags: ["web-clip"],
  });
  const annotation = row({
    path: "references/2026-01-01-note-on-seasonal-sensor-guide.md",
    modified: 1_002,
    id: "demo-annotation-1",
    title: "Note on: Seasonal Sensor Guide",
    url: "https://example.com/sensor-guide",
    category: "annotation",
    tags: ["annotation"],
    excerpt: "compare spring and autumn",
  });

  test("the extension's pair: joined on the one id they share — the URL", () => {
    const g = nestNotes([annotation, clip]);
    expect(g).toHaveLength(1);
    expect(g[0]!.row).toBe(clip);
    expect(g[0]!.notes).toEqual([annotation]);
  });

  test("the GROUP ranks by its subject's time, never the note's", () => {
    // the note is NEWER than its subject and newer than the unrelated row
    // between them; nesting must not let it drag the subject up the feed
    const other = row({ path: "references/other.md", modified: 1_001, id: "x" });
    expect(nestNotes([annotation, other, clip]).map((g) => g.row.path)).toEqual([
      other.path,
      clip.path,
    ]);
  });

  test("the web drop zone's pair: the EXACT id pointer", () => {
    const doc = row({ path: "references/paper.md", modified: 10, id: "d-1", title: "A paper" });
    const note = row({
      path: "references/note-paper.md",
      modified: 11,
      about: "d-1",
      excerpt: "worth citing",
    });
    expect(nestNotes([note, doc])).toEqual([{ row: doc, notes: [note] }]);
  });

  test("a note whose subject is outside the window stays a row of its own", () => {
    // nesting may reshape the feed; it may never make a row vanish from it
    const orphan = row({ path: "references/orphan-note.md", modified: 5, about: "gone" });
    expect(nestNotes([orphan])).toEqual([{ row: orphan, notes: [] }]);
  });

  test("two clips of one URL: the note joins the NEWER capture", () => {
    const stale = row({ ...clip, path: "references/old-clip.md", modified: 1, id: "old" } as never);
    expect(nestNotes([annotation, clip, stale])[0]!.notes).toEqual([annotation]);
    expect(nestNotes([annotation, clip, stale]).map((g) => g.row.path)).toEqual([
      clip.path,
      stale.path,
    ]);
  });

  test("two captures of one URL do NOT nest into each other — only annotations claim a subject", () => {
    const second = row({
      ...clip,
      path: "references/clip-2.md",
      id: "c2",
      modified: 2_000,
    } as never);
    expect(nestNotes([second, clip]).map((g) => g.notes.length)).toEqual([0, 0]);
  });

  test("notes under one subject read oldest-first, each keeping its own time", () => {
    const doc = row({ path: "references/doc.md", modified: 10, id: "d" });
    const a = row({ path: "references/n-a.md", modified: 30, about: "d" });
    const b = row({ path: "references/n-b.md", modified: 20, about: "d" });
    expect(nestNotes([a, b, doc])[0]!.notes.map((n) => n.modified)).toEqual([20, 30]);
  });

  test("a note may not itself be a subject — no chains, no cycles", () => {
    // two annotations pointing at each other must not consume one another
    const x = row({ path: "references/x.md", modified: 1, id: "x", about: "y" });
    const y = row({ path: "references/y.md", modified: 2, id: "y", about: "x" });
    expect(nestNotes([x, y])).toEqual([
      { row: x, notes: [] },
      { row: y, notes: [] },
    ]);
  });

  test("an ordinary feed is untouched — every row a group of one", () => {
    const rows = [row({ path: "a.md", modified: 3 }), row({ path: "b.md", modified: 2 })];
    expect(nestNotes(rows)).toEqual([
      { row: rows[0]!, notes: [] },
      { row: rows[1]!, notes: [] },
    ]);
  });

  test("the editor may reassign `category:` — the landing-stamped tag still nests it", () => {
    const recat = row({ ...annotation, category: "reading" } as never);
    expect(nestNotes([recat, clip])[0]!.notes).toEqual([recat]);
  });
});

describe("noteLabel", () => {
  test("the note's own words — its title is only its subject's title", () => {
    expect(
      noteLabel({ excerpt: "compare spring and autumn", title: "Note on: Modeling the US-Europe Paradox" })
    ).toBe("compare spring and autumn");
  });

  test("no body: a bare marker, never an echo of the row above", () => {
    expect(noteLabel({ title: "Note on: Modeling the US-Europe Paradox" })).toBe("note");
    expect(noteLabel({})).toBe("note");
  });

  test("a note with a title of its OWN keeps it", () => {
    expect(noteLabel({ title: "Second thoughts" })).toBe("Second thoughts");
  });
});

describe("the FILED BY filter (Nick, 2026-08-20)", () => {
  // Minimal arrival rows: type "source" passes isReference, and the label
  // fields are exactly what the wire carries.
  const row = (over: Partial<RecentEntry>): RecentEntry => ({
    path: `log/insertions/2026-08/${Math.random().toString(16).slice(2)}.json`,
    modified: 1,
    author: "intake",
    action: "added",
    band: "person",
    type: "source",
    ...over,
  });
  const agentRow = row({ band: "agent", via: "claude code on Mac-mini.local" });
  const legacyAgentRow = row({ band: "agent", from: "claude-code", source: "agent-chat" });
  const granolaRow = row({ band: "service", from: "granola", source: "granola" });
  const extensionRow = row({ band: "person", via: "web-extension" });

  test("chips: one per distinct label across rows AND graph nodes, sorted, agents marked", () => {
    const chips = filerChips(
      [agentRow, legacyAgentRow, granolaRow, extensionRow, granolaRow],
      [{ band: "service", from: "whoop-api-v2" }]
    );
    expect(chips).toEqual([
      { label: "claude code", agent: true },
      { label: "claude code on Mac-mini.local", agent: true },
      { label: "granola", agent: false },
      { label: "web extension", agent: false },
      { label: "whoop api v2", agent: false },
    ]);
  });

  test("chips: entity nodes, label-less rows, and non-arrival rows contribute nothing", () => {
    const chips = filerChips(
      [row({ band: "engine" }), row({ type: "note", via: "never-counted" })],
      [{ entity: true, band: "agent", from: "claude-code" }, { band: "engine" }]
    );
    expect(chips).toEqual([]);
  });

  test("defaults: agents OFF, everything else ON; an explicit choice wins both ways", () => {
    const chips = filerChips([agentRow, granolaRow], []);
    expect(offFilers(chips, {})).toEqual(new Set(["claude code on Mac-mini.local"]));
    expect(
      offFilers(chips, { "claude code on Mac-mini.local": true, granola: false })
    ).toEqual(new Set(["granola"]));
  });

  test("the product's own doors default ON even when their token is agent-kind", () => {
    // the retired hosted feedback door delivered through an agent-kind token named
    // bigbrain-feedback, so its rows are band "agent" — but it is the
    // product's integration, not the user's agent session (Nick,
    // 2026-08-20: feedback, extension, granola always selected by default).
    const feedbackRow = row({
      band: "agent",
      from: "bigbrain-feedback",
      via: "bigbrain-feedback",
      source: "api",
    });
    const webRow = row({ band: "agent", from: "web-drop", via: "web", source: "web" });
    const chips = filerChips([feedbackRow, agentRow, granolaRow, extensionRow, webRow], []);
    expect(chips).toContainEqual({ label: "bigbrain feedback", agent: true });
    // agent-band, yet ON: only the true agent session stays off
    expect(offFilers(chips, {})).toEqual(new Set(["claude code on Mac-mini.local"]));
    // an explicit OFF still wins over the pin — the user outranks the product
    expect(offFilers(chips, { "bigbrain feedback": false })).toEqual(
      new Set(["bigbrain feedback", "claude code on Mac-mini.local"])
    );
  });

  test("rows: the OFF set drops matching rows; a label-less row is never filtered", () => {
    const off = new Set(["claude code on Mac-mini.local"]);
    expect(filerAllows(agentRow, off)).toBe(false);
    expect(filerAllows(granolaRow, off)).toBe(true);
    expect(filerAllows(row({ band: "engine" }), off)).toBe(true);
    expect(filerAllows(agentRow, new Set())).toBe(true);
  });

  test("nodes: hidden ids match the same labels, entities and label-less nodes exempt", () => {
    const nodes = [
      { id: "source:ins_a", band: "agent" as const, via: "claude code on Mac-mini.local" },
      { id: "source:ins_b", band: "service" as const, from: "granola", source: "granola" },
      { id: "ent_c", entity: true as const, band: "agent" as const, from: "claude-code" },
      { id: "notes/topics/x.md" },
    ];
    const off = new Set(["claude code on Mac-mini.local", "granola"]);
    expect(hiddenFilerNodeIds(nodes, off)).toEqual(new Set(["source:ins_a", "source:ins_b"]));
    expect(hiddenFilerNodeIds(nodes, new Set())).toEqual(new Set());
  });

  test("a graph node and a feed row wearing the same provenance get ONE label", () => {
    // the invariant the whole feature rests on: filedByLabel is the single
    // labeller for both surfaces, so a chip toggles them together
    const label = filedByLabel(agentRow);
    const chips = filerChips([], [{ band: "agent", via: "claude code on Mac-mini.local" }]);
    expect(chips.map((c) => c.label)).toEqual([label]);
  });
});

describe("the grouped legacy family", () => {
  test("`other` is never a chip — and so never filtered: its rows and nodes always show", () => {
    const otherRow = row({ path: "references/o.md", modified: 1, type: "reference", status: "filed", via: "other", from: "nick@x.com" });
    const chips = filerChips([otherRow], [{ via: "other", from: "", source: "", band: "person" }]);
    expect(chips.map((c) => c.label)).not.toContain("other");
    // no chip ⇒ no choice can put it in the OFF set ⇒ its rows always pass
    const off = offFilers(chips, { other: false });
    expect(off.has("other")).toBe(false);
    expect(filerAllows(otherRow, off)).toBe(true);
  });
});

test("session model is distinct from its filing model", () => {
  expect(agentModelLabel({ via: "claude-code", agentModel: "claude-sonnet-4-5", filedModel: "claude-haiku-4-5" })).toBe("sonnet 4.5");
  expect(agentModelLabel({ via: "codex", agentModel: "gpt-6-astra" })).toBe("gpt-6-astra");
  expect(agentModelLabel({ via: "claude-code", filedModel: "claude-haiku-4-5" })).toBe("");
});

test("unknown provenance tags stay blank", () => {
  expect(tagLabel({ via: "claude code", from: "claude-code", band: "agent" })).toBe("");
  expect(tagLabel({ via: "claude code", from: "claude-code", agentModel: " N/A ", sourceDetail: "n/a", band: "agent" })).toBe("");
  expect(tagLabel({ via: "codex", from: "codex", band: "agent" })).toBe("");
  expect(tagLabel({ via: "codex", agentModel: "gpt-6-astra" })).toBe("gpt-6-astra");
});
