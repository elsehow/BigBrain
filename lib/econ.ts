/**
 * econ.ts — the per-vault unit-economics readout (#324).
 *
 * The number the system exists to minimize is COST PER CORRECTLY ANSWERED
 * QUERY. This module assembles the QUERY half from the retrieval ledger:
 * how often retrieval was asked, how often it answered, and the two failure
 * signatures worth trending. The spend half joins in bin/econ.ts, from
 * whatever spend records exist on the box (#85 tracks making those real).
 *
 * Everything here is pure over ledger records, like labels()/heat() — the
 * ledger holds query strings, which are content, so this runs ON THE BOX
 * per vault and only names-and-counts should ever leave it.
 *
 * The tripwire (#327): a VOCABULARY GAP is a search that returned nothing
 * for a note the vault demonstrably had. We cannot see "demonstrably had"
 * directly, but the reformulation burst is its observable shadow — an agent
 * asks, strikes zero, rephrases, and a later spelling lands. The first prod
 * burst (2026-08-12 17:17, six queries in eight seconds, three zero-result,
 * answered on the fourth) is the shape this counts. Rising gap counts are
 * the measured entry signal for the phase-2 embeddings column.
 */

import type { RetrievalLabel, RetrievalVia } from "./retrieval";

/** Two searches on the same door within this (inclusive) read as one intent
 * being rephrased. Generous next to TYPEAHEAD_MS (5s), which has already
 * collapsed keystroke prefixes by the time labels exist — this window is
 * about an agent or a person trying again, not typing.
 *
 * KNOWN BLIND SPOT, inherited from that collapse: a retry that EXTENDS the
 * failed query within 5s ("mamdani" → "mamdani primary") deletes the
 * zero-result member before bursts() sees it, so that reformulation shape
 * never counts as a vocabulary gap. Distinct rephrasings — the observed
 * prod burst shape — survive. If gap counts ever look implausibly low,
 * feeding bursts() un-collapsed searches is the fix, not widening windows. */
export const BURST_MS = 60_000;

/** A run of same-door searches, each within BURST_MS of the previous. */
export interface Burst {
  via: RetrievalVia;
  /** ISO time of the first search in the run. */
  at: string;
  /** Queries in issue order. */
  queries: string[];
  /** Members that showed nothing at all. */
  zeroResults: number;
  /** True when a member AFTER the first zero-result was acted on — the
   * vault had the answer; the first spelling missed it. */
  recovered: boolean;
}

/** Group labels into reformulation bursts (length ≥ 2). Labels arrive
 * time-ordered from labels(); this only walks them. CLI labels are included
 * — a burst's zero-results are observable on any door even though CLI uses
 * are not. */
export function bursts(ls: readonly RetrievalLabel[], windowMs: number = BURST_MS): Burst[] {
  const out: Burst[] = [];
  const open = new Map<RetrievalVia, { members: RetrievalLabel[]; lastMs: number }>();
  const flush = (via: RetrievalVia): void => {
    const run = open.get(via);
    if (run && run.members.length >= 2) {
      const zero = run.members.filter((m) => !m.shown.length);
      const firstZero = run.members.findIndex((m) => !m.shown.length);
      out.push({
        via,
        at: run.members[0]!.at,
        queries: run.members.map((m) => m.q),
        zeroResults: zero.length,
        recovered:
          firstZero !== -1 && run.members.slice(firstZero + 1).some((m) => m.used.length > 0),
      });
    }
    open.delete(via);
  };
  for (const l of ls) {
    const ms = Date.parse(l.at);
    if (Number.isNaN(ms)) continue;
    const run = open.get(l.via);
    if (run && ms - run.lastMs <= windowMs) {
      run.members.push(l);
      run.lastMs = ms;
    } else {
      flush(l.via);
      open.set(l.via, { members: [l], lastMs: ms });
    }
  }
  // Deleting the current key mid-iteration is safe for a Map iterator.
  for (const via of open.keys()) flush(via);
  return out;
}

/** Bursts carrying the vocabulary-gap signature: struck zero, then a later
 * rephrasing was acted on. The tripwire count (#327). */
export function vocabularyGaps(bs: readonly Burst[]): Burst[] {
  return bs.filter((b) => b.zeroResults > 0 && b.recovered);
}

/**
 * Crude, stated-as-crude query shapes — the falsifiable version of "entity
 * files are the right materialized view." If misses cluster off the entity
 * shape, the fix is a different view, not better dossiers.
 *
 *   time    — the query names a date, a year, or a relative period
 *   entity  — what answered (or, unanswered, what was shown) is a dossier
 *   other   — answered from anywhere else
 *   unknown — nothing shown, nothing to infer from
 */
export type QueryShape = "time" | "entity" | "other" | "unknown";

// A month name only counts NEXT TO A DIGIT ("may 2026", "12 march") — bare,
// the alternation reads ordinary English as time ("it may help", "august
// wilson"), and time is checked first, so it would steal from the very
// buckets this classifier exists to compare. Bare-month queries land on
// their evidence shape instead; that trade loses "march retrospective" and
// is accepted.
const MONTH =
  "(january|february|march|april|may|june|july|august|september|october|november|december)";
const TIME_RE = new RegExp(
  `\\b(20\\d\\d|yesterday|today|(last|this)\\s+(week|month|year)|${MONTH}\\s+\\d{1,4}|\\d{1,2}\\s+${MONTH})\\b`,
  "i"
);

export function queryShape(l: RetrievalLabel): QueryShape {
  if (TIME_RE.test(l.q)) return "time";
  const evidence = l.used.length ? l.used : l.shown.slice(0, 3);
  if (!evidence.length) return "unknown";
  return evidence.some((p) => p.startsWith("entities/")) ? "entity" : "other";
}

export function shapeCounts(ls: readonly RetrievalLabel[]): Record<QueryShape, number> {
  const out: Record<QueryShape, number> = { time: 0, entity: 0, other: 0, unknown: 0 };
  for (const l of ls) out[queryShape(l)] += 1;
  return out;
}
