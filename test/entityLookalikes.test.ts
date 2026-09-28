import { describe, expect, test } from "bun:test";
import {
  createLookalikeFinder,
  editDistance,
  lookalikeRule,
  lookalikes,
  normalizeLabel,
  wordCounts,
  type LabelRow,
} from "../lib/entityLookalikes";

const row = (id: string, label: string, assertions = 1): LabelRow => ({ id, label, assertions });

// Invented labels and counts: own labels first, then aliases, as projectedLabelRows serves them.
const RECORD: LabelRow[] = [
  row("fri", "Field Research Institute", 80),
  row("gfi", "Good Food Institute", 3),
  row("fli", "Future of Life Institute", 2),
  row("fsi", "Foresight Institute", 1),
  row("ek", "Evan Keller", 100),
  row("pt", "Peter Sutton", 12),
  row("hx", "Hadley Wu", 30),
  row("briar", "Briar", 20),
  row("mantic", "Mantic", 15),
  row("canaries", "River-Flow Sensors", 5),
  row("eva", "Erin Vale", 4),
  row("fb", "FieldBench", 60),
  row("fb", "Field Bench", 60), // an alias of FieldBench
];
const rare = (word: string): boolean => (wordCounts(RECORD).get(word)?.size ?? 0) <= 3;

describe("normalizeLabel", () => {
  test("lowercases, strips accents, and makes every punctuation run a space", () => {
    expect(normalizeLabel("Fábio Rocha")).toBe("fabio rocha");
    expect(normalizeLabel("River-Flow  Sensors!")).toBe("river flow sensors");
    expect(normalizeLabel("  UK DSIT ")).toBe("uk dsit");
  });
});

describe("editDistance", () => {
  test("counts substitutions, insertions and adjacent transpositions, capped by length difference", () => {
    expect(editDistance("mantic", "mantix")).toBe(1);
    expect(editDistance("hadley wu", "hadley zhu")).toBe(2);
    expect(editDistance("rocha", "rohca")).toBe(1);
    expect(editDistance("short", "a much longer label")).toBe(3);
  });
});

describe("lookalikeRule — the five rules, and what they leave alone", () => {
  test("same: case, accent, punctuation and spacing variants", () => {
    expect(lookalikeRule("River Flow Sensors", "River-Flow Sensors", rare)).toBe("same");
    expect(lookalikeRule("fábio rocha", "Fabio Rocha", rare)).toBe("same");
  });
  test("spelling: two edits on a long label, one on a short one, never on a tiny one", () => {
    expect(lookalikeRule("Hadley Zhu", "Hadley Wu", rare)).toBe("spelling");
    expect(lookalikeRule("Mantix", "Mantic", rare)).toBe("spelling");
    expect(lookalikeRule("Juliette Danelian", "Juliette Danelin", rare)).toBe("spelling");
    expect(lookalikeRule("Matt", "Mark", rare)).toBeUndefined();
    expect(lookalikeRule("Ken Lu", "Ben Li", rare)).toBeUndefined();
    expect(lookalikeRule("Ran", "Tau", rare)).toBeUndefined();
  });
  test("initials: a one-word label that spells the other's initials, articles skipped", () => {
    expect(lookalikeRule("FRI", "Field Research Institute", rare)).toBe("initials");
    expect(lookalikeRule("GFI", "Good Food Institute", rare)).toBe("initials");
    expect(lookalikeRule("Future of Life Institute", "FLI", rare)).toBe("initials");
  });
  test("stub: a one-word entity that is the first word of the new label", () => {
    expect(lookalikeRule("Briar Williams", "Briar", rare)).toBe("stub");
  });
  test("surname: two multi-word labels ending in the same word", () => {
    expect(lookalikeRule("Pete Sutton", "Peter Sutton", rare)).toBe("surname");
    expect(lookalikeRule("Bea Linden", "Beatrice Linden", rare)).toBe("surname");
  });
  test("token: a shared rare word is evidence, a shared common word is not", () => {
    expect(lookalikeRule("Erin Vale's lab", "Erin Vale", rare)).toBe("token");
    // four institutes carry "institute": no rule fires on the fifth
    expect(lookalikeRule("Anthropic Institute", "Field Research Institute", rare)).toBeUndefined();
    expect(lookalikeRule("Anthropic Institute", "Good Food Institute", rare)).toBeUndefined();
    // a function word long enough to pass the length gate is still no evidence
    expect(lookalikeRule("Notes from Evan", "Letter from Bob", rare)).toBeUndefined();
  });
  test("silent on renames and on names that merely share a first name, title or not", () => {
    expect(lookalikeRule("Ridgeways", "Auto-MAP", rare)).toBeUndefined();
    expect(lookalikeRule("Evan Klein", "Evan Keller", rare)).toBeUndefined();
    expect(lookalikeRule("Dr Evan Klein", "Evan Keller", rare)).toBeUndefined();
    expect(lookalikeRule("Alex Otis", "Alex Rowan", rare)).toBeUndefined();
  });
  test("silent across a digit change: versions are different things", () => {
    expect(lookalikeRule("GPT-5", "GPT-4", rare)).toBeUndefined();
    expect(lookalikeRule("Claude 4 Opus", "Claude 3 Opus", rare)).toBeUndefined();
    expect(lookalikeRule("Claude Opus 4.5", "Claude", rare)).toBeUndefined();
    expect(lookalikeRule("Claude 4 Opus", "claude 4 opus", rare)).toBe("same");
  });
  test("initials need three letters: two-letter labels are not initialisms", () => {
    expect(lookalikeRule("AI", "Anthropic Institute", rare)).toBeUndefined();
    expect(lookalikeRule("UK", "Ursula Kroeber", rare)).toBeUndefined();
  });
});

describe("lookalikes — the candidates for a refusal", () => {
  test("one row per entity, most-cited first, the matching alias named, capped", () => {
    expect(lookalikes("Field bench", RECORD)).toEqual([
      { id: "fb", label: "FieldBench", assertions: 60, rule: "same", via: "Field Bench" },
    ]);
    expect(lookalikes("Fieldbench", RECORD)[0]).toMatchObject({ id: "fb", label: "FieldBench", rule: "same", via: "FieldBench" });
    expect(lookalikes("FRI", RECORD).map((c) => c.label)).toEqual(["Field Research Institute"]);
    expect(lookalikes("Anthropic Institute", RECORD)).toEqual([]);
    expect(lookalikes("Briar Williams", RECORD, 1)).toHaveLength(1);
  });
  test("a rare word stays rare however many aliases one entity spells it in", () => {
    const folded = [...RECORD, row("eva", "Vale"), row("eva", "E. Vale"), row("eva", "Erin V."), row("eva", "Dr Vale")];
    expect(wordCounts(folded).get("vale")?.size).toBe(1);
    expect(lookalikes("Erin Vale's lab", folded)[0]).toMatchObject({ id: "eva", rule: "token" });
  });
  test("an empty or whitespace label matches nothing", () => {
    expect(lookalikes("   ", RECORD)).toEqual([]);
    expect(lookalikes("!!!", RECORD)).toEqual([]);
  });
});


test("Unicode labels retain their script and meaningful marks, with common Latin folds", () => {
  expect(normalizeLabel("北京大学！")).toBe("北京大学");
  expect(lookalikeRule("北京大学！", "北京大学", rare)).toBe("same");
  expect(lookalikeRule("東京", "北京", rare)).toBeUndefined();
  expect(lookalikeRule("Łukasz Kowalski", "Lukasz Kowalski", rare)).toBe("same");
  expect(lookalikeRule("Søren Straße", "Soren Strasse", rare)).toBe("same");
  expect(normalizeLabel("ガイド")).toBe("ガイド");
  expect(normalizeLabel("किरण")).toBe("किरण");
  expect(normalizeLabel("가이드")).toBe("가이드");
  expect(lookalikeRule("東京モデル２", "東京モデル３", rare)).toBeUndefined();
  expect(normalizeLabel("!!!")).toBe("");
  expect(lookalikeRule("𠮷田", "𠮷川", rare)).toBeUndefined();
  expect(editDistance("𠮷", "田")).toBe(1);
});

test("a prepared lookup preserves canonical labels, aliases, rarity and ordering", () => {
  const find = createLookalikeFinder(RECORD);
  for (const label of ["Field bench", "FRI", "Erin Vale's lab", "Briar Williams", "!!!"])
    expect(find(label)).toEqual(lookalikes(label, RECORD));
  expect(find("Field bench")).toEqual([{ id: "fb", label: "FieldBench", assertions: 60, rule: "same", via: "Field Bench" }]);
});
