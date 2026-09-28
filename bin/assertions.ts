#!/usr/bin/env bun
/**
 * assertions.ts — `bigbrain assertions`: a date-ordered WINDOW over the
 * live record, and the roll-up of who it is about.
 *
 * `bigbrain search` is a find-X door: it requires a query term and answers
 * with ranked hits. That leaves the other half of retrieval unserved — the
 * SLICE, "everything since 2026-08-22, newest content first" — which is
 * what a survey actually reaches for. So every memory run built one:
 * ~15 turns of throwaway Python over the raw JSON logs, in a different
 * shape each time (#686). Three from-scratch runs each saw 8-13% of the
 * record and overlapped on 30% of what they saw.
 *
 *   bigbrain assertions --since 2026-08-22            # a window, newest first
 *   bigbrain assertions --entity ent_4166c7b217ce     # one entity's thread
 *   bigbrain assertions --since 2026-08-01 --json     # for a pass to parse
 *   bigbrain assertions --entities                    # the map: who, how much, when
 *
 * Dates are CONTENT dates — the `occurred_at` of the sources an assertion
 * cites, not the day the gardener asserted it. The distinction is the whole
 * point of the door: `created_at` collapses to import day.
 *
 * Read-only on content; the only write is the rebuildable projection under
 * .state/, synced before the read so a just-landed arrival is listed.
 */

import { requireVaultRoot } from "../lib/engine";
import {
  listAssertions,
  syncAssertionProjection,
  tallyAssertionEntities,
  type AssertionListFilters,
} from "../lib/assertionProjection";
import { flagValue, hasFlag } from "../lib/cliflags";

/** Bounded by default: a bare `assertions` over the canary's record is
 * 3,188 rows and ~1.2MB, which is a context bomb for the very caller this
 * door exists to serve. The remainder is always disclosed, never dropped
 * silently — `--limit 0` asks for all of it. */
const DEFAULT_LIMIT = 200;

const argv = process.argv.slice(2);
const json = hasFlag(argv, "json");
const entitiesOnly = hasFlag(argv, "entities");

// A model that cannot find a door asks it for help, and a --help that
// silently lists 25 assertions instead reads as "no such command" — which
// is how one measurement run concluded the door did not exist and went
// back to hand-rolling an index (#686).
if (hasFlag(argv, "help") || hasFlag(argv, "h")) {
  console.log(`usage: bigbrain assertions [--since YYYY-MM-DD] [--until YYYY-MM-DD]
                           [--entity <id>] [--limit N] [--entities] [--json]

A date-ordered window over the live record, newest CONTENT date first —
the date an assertion's SOURCES carry, never the day it was asserted.

  --since / --until   inclusive day bounds on that content date
  --entity <id>       one entity's thread (alias ids resolve to their target)
  --limit N           default ${DEFAULT_LIMIT}; --limit 0 for the whole window
  --entities          instead: every entity, its citation count and span
  --json              machine-readable, for a pass to parse`);
  process.exit(0);
}

// Same validation and same spelling as search's --after/--before: a bad
// day exits 2 with the correction, never a silently empty window.
const dayFlag = (name: string): string | undefined => {
  const v = flagValue(argv, name);
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    console.error(`assertions: bad --${name} "${v}" — use YYYY-MM-DD, e.g. --${name} 2026-08-01`);
    process.exit(2);
  }
  return v;
};

const limitArg = flagValue(argv, "limit");
if (limitArg !== undefined && !/^\d+$/.test(limitArg)) {
  console.error(`assertions: bad --limit "${limitArg}" — use a whole number, or omit it for every match`);
  process.exit(2);
}

const since = dayFlag("since");
const until = dayFlag("until");
const entity = flagValue(argv, "entity");
const filters: AssertionListFilters = {
  ...(since && { since }),
  ...(until && { until }),
  ...(entity && { entity }),
  limit: limitArg === undefined ? DEFAULT_LIMIT : Number(limitArg),
};

const root = requireVaultRoot();
// A listing must never answer from a stale cache: the pass reads this to
// decide what is new. One-shot, so no debounce — that is the omnibox's
// per-keystroke concern, not a CLI's.
syncAssertionProjection(root);

if (entitiesOnly) {
  const tally = tallyAssertionEntities(root);
  if (json) {
    console.log(JSON.stringify(tally, null, 2));
    process.exit(0);
  }
  for (const e of tally)
    console.log(`${e.id} · ${e.label} · ${e.assertions} · ${e.first === e.last ? e.first : `${e.first}..${e.last}`}`);
  process.exit(0);
}

// One past the page, so the tail can be counted without a second query.
const page = filters.limit ? listAssertions(root, { ...filters, limit: filters.limit + 1 }) : [];
const more = filters.limit && page.length > filters.limit;
const rows = filters.limit ? page.slice(0, filters.limit) : listAssertions(root, filters);
if (json) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (!rows.length) {
  console.error("assertions: no live assertions match that window");
  process.exit(0);
}

for (const r of rows) {
  const labels = r.entities.map((e) => e.label).join(", ");
  console.log(`${r.date.slice(0, 10)}  ${r.id}${labels ? `  [${labels}]` : ""}`);
  console.log(`  ${r.text.replace(/\s+/g, " ").trim()}`);
}
if (more)
  console.error(
    `assertions: showing the newest ${rows.length}; older matches remain — narrow with --since/--until, or --limit 0 for the whole window`
  );
