/**
 * memoryTree.ts — the memory pass's tree, and the budget it is held to.
 *
 * Split out of lib/memoryRun.ts (#640), where reading the tree, measuring
 * it, reverting it and describing the overage were four closures inside a
 * 620-line function — each needing only `root`, none needing the run.
 *
 * The budget: MEMORY.md + 8 topic files; ~3,000 words is what the prompt
 * aims at, 3,300 is the line the code holds — 10% slack for a model that
 * counts exactly but writes by feel.
 *
 * #598: these used to be "roughly 3,000" in the prompt and a silent
 * wholesale revert at 3,300 in the code, ten percent apart with nothing
 * between them. The model runs `wc`, reports its count to the word, and
 * read "roughly" as advisory: it submitted 6–23% over, run after run
 * ("flagging rather than cutting", in its own report), each reverted run
 * cost $1–4, and the retry saw a byte-identical prompt and the same tree
 * — a blind re-draw that passed only when that sample happened to prune.
 * Now the prompt names both numbers and what happens past the line, the
 * run context says where the tree stands, an over-budget tree goes back
 * to the model with the measured overage (MEMORY_TRIM_ATTEMPTS turns),
 * and only a tree still over after that is reverted — with the next run
 * told so. The measure is `cat memory/**\/*.md | wc -w`, the same command
 * the model runs, so the two never disagree; a `[[ast_…]]` is a word.
 */

import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { machinePath } from "./run/machineTools";

export const MEMORY_MAX_FILES = 9;
export const MEMORY_TARGET_WORDS = 3_000;
export const MEMORY_MAX_WORDS = 3_300;
/** How many times an over-budget tree is handed back for trimming before
 * the run is reverted — the runaway guard the revert always was. */
export const MEMORY_TRIM_ATTEMPTS = 2;

/** The budget's measure of a tree: `cat memory/**\/*.md | wc -w`. */
export interface TreeMeasure {
  files: string[];
  words: number;
  /** per file, memory-relative — what a trim turn is shown */
  perFile: [string, number][];
}

/** memory/ paths present in the working tree right now, relative to memory/. */
export function memoryTreeFiles(root: string): string[] {
  const dir = join(root, "memory");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const f of readdirSync(d)) {
      const p = machinePath(root, `memory/${rel}${f}`);
      if (lstatSync(p).isDirectory()) walk(p, `${rel}${f}/`);
      else if (f.endsWith(".md")) out.push(`${rel}${f}`);
    }
  };
  walk(dir, "");
  return out;
}

export function measureTree(root: string): TreeMeasure {
  const files = memoryTreeFiles(root);
  const perFile = files.map((f): [string, number] => [
    f,
    readFileSync(join(root, "memory", f), "utf8").split(/\s+/).filter(Boolean).length,
  ]);
  return { files, words: perFile.reduce((n, [, w]) => n + w, 0), perFile };
}

export const overBudget = (m: TreeMeasure): boolean =>
  m.files.length > MEMORY_MAX_FILES || m.words > MEMORY_MAX_WORDS;

export const describeBudget = (m: TreeMeasure): string =>
  `${m.files.length} file(s) (max ${MEMORY_MAX_FILES}), ${m.words} word(s) (max ${MEMORY_MAX_WORDS})`;

/** The trim turn's prompt (#598): the run's own pen, handed back with the
 * numbers. Runner-owned text, not a prompts/ template — it is mechanical
 * (a measurement and a rule), and a vault seeded before it existed must
 * not fail for lack of a file. */
export function trimPrompt(m: TreeMeasure, attempt: number, report: string): string {
  const overWords = Math.max(0, m.words - MEMORY_MAX_WORDS);
  const overFiles = Math.max(0, m.files.length - MEMORY_MAX_FILES);
  const cut = [
    overWords ? `at least ${overWords} words (to ${MEMORY_MAX_WORDS}; aim lower — ~${MEMORY_TARGET_WORDS} is the target)` : "",
    overFiles ? `${overFiles} file(s) (to ${MEMORY_MAX_FILES})` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const perFile = m.perFile
    .slice()
    .sort((a, b) => b[1] - a[1])
    .map(([f, w]) => `- memory/${f} — ${w} words`)
    .join("\n");
  return `# Memory pass — trim turn ${attempt} of ${MEMORY_TRIM_ATTEMPTS}

Reduce the memory tree to the limits below. The runner discards the result
if it remains over budget after the available trimming attempts.

Measured as \`cat memory/**/*.md | wc -w\` (a \`[[ast_…]]\` citation is a word):

- now: ${m.words} words in ${m.files.length} files
- line: ${MEMORY_MAX_WORDS} words, ${MEMORY_MAX_FILES} files
- cut: ${cut}

Per file:

${perFile}

Rules:

- Cut, merge, compress — never add. Prefer dropping whole low-value
  paragraphs to shaving a word from every line: the record keeps
  everything, and a memory line that is gone is one search away.
- Keep the citation on every claim you keep; a claim that would lose its
  \`[[ast_…]]\` is a claim to drop.
- Keep MEMORY.md's index in step with the files: a merged or deleted
  topic leaves the index.
- Write ONLY under memory/.
- Re-measure before you finish — \`cat memory/**/*.md | wc -w\` under
  ${MEMORY_MAX_WORDS} — and end your final message with a \`\`\`report block:
  what you cut and why.

## The run's own report — what it added and why

${report || "(none)"}
`;
}
