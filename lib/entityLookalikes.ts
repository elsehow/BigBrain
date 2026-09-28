/**
 * entityLookalikes.ts — the labels an existing entity might already be
 * known by, for the intake guard (lib/assertionAgent.ts).
 *
 * An entity's id is hash(label), so every spelling the gardener writes is
 * a new entity unless something stops it. The #628 guard stops a bare
 * first name ("Evan" beside Evan Keller). The rules below catch spelling,
 * initials, and other recognizable variants. Renames and ambiguous first
 * names still need the fold pass's contextual judgment (lib/entityFolds.ts).
 *
 * The rules, on labels normalized to lowercase Unicode words — none of them
 * across a digit change, since "GPT-5" and "GPT-4" are two things however
 * alike they read:
 *   same     — equal once case, accents, punctuation and spacing are gone
 *              ("River-Flow Sensors" / "River Flow Sensors")
 *   spelling — within two edits, one under eight characters
 *              ("Hadley Zhu" / "Hadley Wu", "Mantix" / "Mantic")
 *   initials — a one-word label that is the other's initials
 *              ("FRI" / "Field Research Institute")
 *   stub     — a one-word entity that is the first word of a longer new
 *              label ("Briar" beside "Briar Williams")
 *   surname  — two multi-word labels ending in the same rare word
 *              ("Pete Sutton" / "Peter Sutton"; not two Institutes)
 *   token    — a shared word at least four letters long that at most
 *              three entities in the record carry: "Vale" is evidence,
 *              "Institute" is not, and a first name two full names share
 *              never is (Evan Klein beside Evan Keller stays a mint)
 *
 * Pure: the caller hands it every live label the record holds (each with
 * its canonical id and merged count — lib/assertionProjection.ts
 * projectedLabelRows) and gets back the candidates, most-cited first.
 */

export interface LabelRow {
  /** the canonical entity this label names */
  id: string;
  /** the entity's own label, or one of its aliases */
  label: string;
  /** the entity's merged live claim count */
  assertions: number;
}

export type LookalikeRule = "same" | "spelling" | "initials" | "stub" | "surname" | "token";
/** Strongest first — the order lookalikeRule tries them, and the one that names a match. */
export const RULE_RANK: readonly LookalikeRule[] = ["same", "initials", "stub", "surname", "spelling", "token"];

export interface Lookalike {
  id: string;
  /** the canonical entity's OWN label, for the refusal */
  label: string;
  assertions: number;
  rule: LookalikeRule;
  /** the label the rule matched (an alias may be what looked alike) */
  via: string;
}

/** Words at least this long carry evidence; "of", "AI", "Dr" do not. */
export const MIN_WORD = 4;
/** A shared word that this many entities or fewer carry is a rare one. */
export const RARE_WORD_LABELS = 3;
/** Edits allowed between two spellings of one thing. */
export const MAX_EDITS = 2;

const STOP = new Set(["of", "for", "and", "the", "de", "du", "von", "van", "at", "in", "on"]);
/** Titles a person's label may open with — the first name is the word after. */
const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "professor", "sir", "dame"]);
/** An initialism has to be at least this long: "AI" is not "Anthropic Institute". */
const MIN_INITIALS = 3;
/** Long enough to pass MIN_WORD, and still no evidence: "Notes from Evan"
 * shares nothing with "Letter from Bob". */
const FUNCTION_WORDS = new Set([
  "about", "above", "after", "also", "been", "before", "between", "from", "have", "into", "more", "most",
  "notes", "over", "some", "such", "than", "that", "their", "then", "there", "these", "this", "under",
  "very", "what", "when", "where", "which", "while", "with", "would", "your",
]);
/** Under this many characters a spelling gets one edit, not two: "Matt"
 * is not "Mark", "Ken Lu" is not "Ben Li". */
const SHORT_LABEL = 8;

/** Fold Latin accents and common non-decomposing Latin letters, keeping
 * other scripts intact (including meaningful combining marks). This is only
 * a similarity key, never an entity ID or a rewrite of a stored label. */
const LATIN_FOLD: Record<string, string> = { ł: "l", ø: "o", ß: "ss", æ: "ae", œ: "oe", ð: "d", đ: "d", þ: "th" };
export const normalizeLabel = (label: string): string =>
  label.toLowerCase().normalize("NFD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .replace(/[łøßæœðđþ]/gu, letter => LATIN_FOLD[letter]!)
    .normalize("NFC").replace(/[^\p{L}\p{N}\p{M} ]+/gu, " ").replace(/\s+/g, " ").trim();

const words = (normalized: string): string[] => (normalized ? normalized.split(" ") : []);
const charCount = (value: string): number => Array.from(value).length;
const evidence = (ws: readonly string[]): string[] => ws.filter((w) => charCount(w) >= MIN_WORD && !FUNCTION_WORDS.has(w));
const initialsOf = (ws: readonly string[]): string => ws.filter((w) => !STOP.has(w)).map((w) => Array.from(w)[0]!).join("");
/** The digits a label carries, in order: "GPT-5" and "GPT-4" differ here,
 * and no spelling or shared word makes two versions one thing. */
const digitRuns = (normalized: string): string => (normalized.match(/\p{N}+/gu) ?? []).join(" ");
/** A person label's first name: the first word that is not a title. */
const firstName = (ws: readonly string[]): string | undefined => ws.find((w) => !TITLES.has(w));

/** Damerau-Levenshtein (adjacent transposition counts one), capped: any
 * pair whose lengths differ by more than `max` is `max + 1` at once. */
export function editDistance(left: string, right: string, max = MAX_EDITS): number {
  const a = Array.from(left), b = Array.from(right);
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array.from({ length: b.length }, () => 0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The rule under which `candidate` (an existing label) looks like `label`
 * (the new one), or undefined. `rare` answers whether a word is carried by
 * few enough labels to be evidence on its own. */
export function lookalikeRule(label: string, candidate: string, rare: (word: string) => boolean): LookalikeRule | undefined {
  return normalizedRule(normalizeLabel(label), normalizeLabel(candidate), rare);
}

function normalizedRule(a: string, b: string, rare: (word: string) => boolean): LookalikeRule | undefined {
  if (!a || !b) return undefined;
  if (a === b) return "same";
  if (digitRuns(a) !== digitRuns(b)) return undefined;
  const wa = words(a), wb = words(b), aLength = charCount(a), bLength = charCount(b);
  if (wa.length === 1 && wb.length > 1 && aLength >= MIN_INITIALS && a === initialsOf(wb)) return "initials";
  if (wb.length === 1 && wa.length > 1 && bLength >= MIN_INITIALS && b === initialsOf(wa)) return "initials";
  if (wb.length === 1 && wa.length > 1 && wa[0] === b) return "stub";
  if (wa.length > 1 && wb.length > 1) {
    const last = wa[wa.length - 1]!;
    if (charCount(last) >= MIN_WORD && last === wb[wb.length - 1] && rare(last)) return "surname";
  }
  if (aLength >= MIN_WORD && bLength >= MIN_WORD) {
    const budget = Math.min(aLength, bLength) < SHORT_LABEL ? 1 : MAX_EDITS;
    if (editDistance(a, b, budget) <= budget) return "spelling";
  }
  // a first name two multi-word labels share is no evidence: Evan Klein
  // (or Dr Evan Klein) is not Evan Keller, and the record holds both on purpose
  const shared = new Set(evidence(wb));
  const sharedFirstName = wa.length > 1 && wb.length > 1 && firstName(wa) === firstName(wb) ? firstName(wa) : undefined;
  if (evidence(wa).some((w) => w !== sharedFirstName && shared.has(w) && rare(w))) return "token";
  return undefined;
}

/** How many ENTITIES carry each evidence word across their labels —
 * computed once per record so a shared "institute" is weighed against
 * every institute it names. Entities, not rows: an entity with three
 * aliases spelling its surname is one carrier, or the most-folded names
 * would be the least protected. */
export function wordCounts(rows: readonly LabelRow[]): Map<string, Set<string>> {
  const carriers = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const w of new Set(evidence(words(normalizeLabel(row.label))))) {
      const ids = carriers.get(w) ?? new Set<string>();
      ids.add(row.id);
      carriers.set(w, ids);
    }
  }
  return carriers;
}

/** The existing entities `label` might already name, most-cited first,
 * one row per entity (its own label, with the alias that matched noted).
 * `rows` is every live label — own labels and aliases — as
 * projectedLabelRows serves them. */
export function lookalikes(label: string, rows: readonly LabelRow[], limit = 8): Lookalike[] {
  return createLookalikeFinder(rows)(label, limit);
}

/** Prepare the live label inventory once for a validation batch. */
export function createLookalikeFinder(rows: readonly LabelRow[]): (label: string, limit?: number) => Lookalike[] {
  const carriers = wordCounts(rows);
  const rare = (word: string): boolean => (carriers.get(word)?.size ?? 0) <= RARE_WORD_LABELS;
  const own = new Map<string, string>();
  for (const row of rows) if (!own.has(row.id)) own.set(row.id, row.label);
  const prepared = rows.map(row => ({ row, normalized: normalizeLabel(row.label) }));
  return (label, limit = 8) => {
    const normalized = normalizeLabel(label);
    // the strongest rule across an entity's labels names it: "Forecast bench"
    // is the SAME as the alias "Forecast Bench", not a spelling of ForecastBench
    const found = new Map<string, Lookalike>();
    for (const { row, normalized: candidate } of prepared) {
      const rule = normalizedRule(normalized, candidate, rare);
      if (!rule) continue;
      const held = found.get(row.id);
      if (held && RULE_RANK.indexOf(held.rule) <= RULE_RANK.indexOf(rule)) continue;
      found.set(row.id, { id: row.id, label: own.get(row.id) ?? row.label, assertions: row.assertions, rule, via: row.label });
    }
    return [...found.values()].sort((x, y) => y.assertions - x.assertions || x.label.localeCompare(y.label)).slice(0, limit);
  };
}
