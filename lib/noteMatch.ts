/**
 * noteMatch.ts — windowing a note's BODY by literal match, and the all-terms
 * vocabulary the record's other windows share.
 *
 * #618 gave a dossier a window (which assertions), because 165 log-ascending
 * bullets are not readable whole. A raw source has the same problem and no
 * window at all: a landed agent-chat transcript is 290KB of speaker-labeled
 * turns, and a reader that asks for it gets head and tail, then hand-writes
 * grep against a temp file to reach the three turns it wanted. This is that
 * grep, in the door, so the answer arrives with the fetch.
 *
 * Purely mechanical — no model, no inference, no ranking. A **block** is a
 * run of non-blank lines: a paragraph in markdown, and exactly one turn in a
 * transcript (lib/agentChat.ts renderTurns joins `speaker: text` with a blank
 * line). A block matches when every query term appears in it, the same
 * all-terms posture search and the dossier filter take; the window keeps each
 * matching block plus `slack` blocks either side, merges overlapping regions
 * and marks what it skipped with the line numbers of the WHOLE note — so the
 * caller can go straight to the region in the saved markdown, or re-ask with
 * a wider slack.
 */

/** `[[path|Label]]` / `[[target]]` reduced to what a reader sees. A query for
 * a person's name must match the label the prose shows, not the `ent_…` id
 * the projection wrote behind it. */
export const stripLinks = (text: string): string =>
  text.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/gu, "$1").replace(/\[\[([^\]]+)\]\]/gu, "$1");

/** A query's terms, lowercased. Punctuation-only input yields none — the
 * caller decides whether that is "no filter" or "matches nothing"; the
 * doors treat it as a real query that matched nothing (searchHandler's
 * policy, #259). */
export const matchTerms = (value: string): string[] =>
  value.toLocaleLowerCase().match(/[\p{L}\p{N}@._+-]+/gu) ?? [];

/** EVERY term present, case-insensitive, links reduced to their labels. */
export const containsAllTerms = (text: string, terms: string[]): boolean => {
  const hay = stripLinks(text).toLocaleLowerCase();
  return terms.every((term) => hay.includes(term));
};

/** One run of non-blank lines, with its 1-based line span in the note. */
export interface BodyBlock {
  text: string;
  from: number;
  to: number;
}

/** Split a body into blocks. Blank-line separated, order preserved, line
 * numbers are the body's own — the same numbering `format=markdown` serves
 * and a line-addressed reader slices. */
export function bodyBlocks(body: string): BodyBlock[] {
  const lines = body.split("\n");
  const blocks: BodyBlock[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const blank = lines[i]!.trim() === "";
    if (!blank && start < 0) start = i;
    if (blank && start >= 0) {
      blocks.push({ text: lines.slice(start, i).join("\n"), from: start + 1, to: i });
      start = -1;
    }
  }
  if (start >= 0)
    blocks.push({ text: lines.slice(start).join("\n"), from: start + 1, to: lines.length });
  return blocks;
}

export interface BodyWindow {
  /** The kept regions, elision markers between them. */
  text: string;
  blocks_total: number;
  blocks_matched: number;
  blocks_shown: number;
  /** Matching blocks the budget could not fit — the caller should narrow. */
  blocks_dropped: number;
}

/** Blocks of context kept either side of a match. Two turns of a transcript
 * is the question that prompted the answer, and the reply to it. */
export const DEFAULT_SLACK = 2;
/** Characters of block text one window may emit. A whole transcript is
 * hundreds of KB; this is the budget that makes the answer fit in a reply. */
export const DEFAULT_BUDGET = 6_000;
/** A single block can be enormous (one tool result, one pasted file). Past
 * this it is clipped around its first matching term. */
const BLOCK_CAP = 2_000;

const clipBlock = (text: string, terms: string[]): string => {
  if (text.length <= BLOCK_CAP) return text;
  const hay = text.toLocaleLowerCase();
  let at = 0;
  for (const term of terms) {
    const i = hay.indexOf(term);
    if (i >= 0) {
      at = i;
      break;
    }
  }
  const start = Math.max(0, at - Math.floor(BLOCK_CAP / 3));
  const end = Math.min(text.length, start + BLOCK_CAP);
  return `${start > 0 ? "… " : ""}${text.slice(start, end)}${end < text.length ? " …" : ""}`;
};

const elision = (from: number, to: number): string => `[… lines ${from}–${to} elided …]`;

/**
 * The regions of `body` matching `q`, plus `slack` blocks of context each
 * side, under a character budget. Everything is deterministic: same body,
 * same query, same bytes.
 */
export function matchBody(
  body: string,
  q: string,
  opts: { slack?: number; budget?: number } = {}
): BodyWindow {
  const blocks = bodyBlocks(body);
  const terms = matchTerms(q);
  const slack = Math.max(0, Math.trunc(opts.slack ?? DEFAULT_SLACK));
  const budget = Math.max(500, Math.trunc(opts.budget ?? DEFAULT_BUDGET));
  const hit = blocks.map((b) => terms.length > 0 && containsAllTerms(b.text, terms));
  const matched = hit.filter(Boolean).length;

  // Matching blocks widened by `slack`, overlapping (and abutting) regions
  // merged, so a run of nearby hits reads as one passage instead of the same
  // turns repeated under three headings.
  const regions: [number, number][] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (!hit[i]) continue;
    const from = Math.max(0, i - slack);
    const to = Math.min(blocks.length - 1, i + slack);
    const last = regions.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else regions.push([from, to]);
  }

  const parts: string[] = [];
  let previous = -1;
  let shown = 0;
  let shownHits = 0;
  let used = 0;
  let stopped = false;
  for (const [a, b] of regions) {
    if (stopped) break;
    for (let i = a; i <= b; i++) {
      const text = clipBlock(blocks[i]!.text, terms);
      // The budget never cuts the FIRST block: a window that answers with
      // nothing but an elision marker is worse than one oversized block.
      if (used + text.length > budget && previous >= 0) {
        stopped = true;
        break;
      }
      if (i > previous + 1)
        parts.push(elision(blocks[previous + 1]!.from, blocks[i - 1]!.to));
      parts.push(text);
      if (hit[i]) shownHits++;
      previous = i;
      shown++;
      used += text.length;
    }
  }
  if (previous >= 0 && previous < blocks.length - 1)
    parts.push(elision(blocks[previous + 1]!.from, blocks.at(-1)!.to));

  return {
    text: parts.join("\n\n"),
    blocks_total: blocks.length,
    blocks_matched: matched,
    blocks_shown: shown,
    blocks_dropped: matched - shownHits,
  };
}
