#!/usr/bin/env bun
/**
 * search.ts — `bigbrain search <query>`: the agent/CLI door into product
 * search. The same `scanSurface` (lib/searchCore.ts) both HTTP doors run
 * (#476): the assertion projection — entities first, then their sources
 * and matching curated memory. An agent on the CLI sees what the same agent
 * sees over /v1/search.
 *
 *   bigbrain search catastrophic risks        # ranked hits, newest wins ties
 *   bigbrain search request --source email       # stored emails only
 *   bigbrain search red lines --limit 5
 *   bigbrain search --json climate            # machine-readable, for agents
 *   bigbrain search --rebuild                  # force a full reindex, then exit
 *   bigbrain search rrsp room --why "planning Q3 taxes"   # spool the demand signal
 *   bigbrain search dana --after 2026-08-01 --type reference   # date/type filters (#349)
 *
 * `--why` attaches the caller's intent to the read and spools it as an
 * observation (the memory pass's demand evidence). Fail-SOFT by design: a
 * lost why loses telemetry, never the search.
 *
 * The vault is resolved by the shared engine discovery (BIGBRAIN_VAULT / cwd /
 * pointer); the CLI wrapper already set it. Read-only on content — the only
 * things written are the rebuildable assertion projection under .state/
 * and the retrieval ledger's label.
 */

import { role as envRole } from "../lib/env";
import { rebuildAssertionProjection } from "../lib/assertionProjection";
import { requireVaultRoot } from "../lib/engine";
import { scanSurface } from "../lib/searchCore";
import { flagValue, hasFlag, positionals } from "../lib/cliflags";

const argv = process.argv.slice(2);
const json = hasFlag(argv, "json");
const doRebuild = hasFlag(argv, "rebuild");

let limit = 25;
const limitArg = flagValue(argv, "limit");
if (limitArg) limit = Math.max(1, Number(limitArg) || 25);

// An empty --why "" reads as absent, same as no --why at all.
const why = flagValue(argv, "why") || undefined;

// Filters (#349) — same validation and same meaning as GET /v1/search:
// inclusive YYYY-MM-DD bounds, two record types. Bad values exit 2 with
// the corrected spelling, matching the API door's instructive 400s.
const dayFlag = (name: string): string | undefined => {
  const v = flagValue(argv, name);
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    console.error(`search: bad --${name} "${v}" — use YYYY-MM-DD, e.g. --${name} 2026-08-01`);
    process.exit(2);
  }
  return v;
};
const after = dayFlag("after");
const before = dayFlag("before");
const typeFlag = flagValue(argv, "type");
if (typeFlag && typeFlag !== "reference" && typeFlag !== "entity") {
  console.error(`search: bad --type "${typeFlag}" — use --type reference or --type entity`);
  process.exit(2);
}
const type = typeFlag as "reference" | "entity" | undefined;

// Positional query = everything that isn't a flag or a flag's value.
const query = positionals(argv, new Set(["limit", "why", "after", "before", "type", "source"]))
  .join(" ")
  .trim();

const root = requireVaultRoot();

if (doRebuild) {
  const r = rebuildAssertionProjection(root);
  console.error(`search: rebuilt the assertion projection (${JSON.stringify(r)})`);
  if (!query) process.exit(0);
}

if (!query) {
  console.error(
    "usage: bigbrain search <query> [--limit N] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--type reference|entity] [--json] [--rebuild]"
  );
  process.exit(2);
}

// A machine pass names itself in BIGBRAIN_ROLE. Ingestion sees only the
// record; readers and the memory pass can discover the curated working set.
const role = envRole();
const filters = {
  ...(flagValue(argv, "source") && { source: flagValue(argv, "source")!.trim().toLowerCase() }),
  ...(after && { after }),
  ...(before && { before }),
  ...(type && { type }),
};
// Interactive callers get the zero-hit relaxation round (#361); machine
// passes stay exact — a pass deciding where to file must not act on a
// fuzzy answer it did not ask for. Interactive searches are the shown
// half of the retrieval ledger (lib/retrieval.ts) — the query and its
// ranked answer, kept as a benchmark label; machine passes are excluded
// for exactly the reason their whys are, below: a pass searching to
// decide where to file is the machinery working, not a person looking
// for something. The USE half arrives through the scaffold's Read hook
// where one is installed.
const r = scanSurface(root, query, limit, "cli", {
  filters, relax: !role, ledger: !role, includeMemory: !role || role === "memory",
});
if (!r.ok) {
  if (r.invalid_query) { console.error(`search: ${r.reason}`); process.exit(2); }
  // The projection/index is a rebuildable cache; its loss is the vault's
  // state, not the query's fault — say so, with the repair.
  console.error(`search: the search cache could not be read — ${r.reason}; try \`bigbrain search --rebuild\``);
  process.exit(1);
}
const hits = r.hits;
const relaxation = r.relaxation;
if (relaxation)
  console.error(
    `search: no exact matches — showing any-term matches for "${query}" (relaxation: ${relaxation})`
  );

// The demand signal rides after the search, fail-soft: a local voice
// arrival (lib/voice.ts). One stderr line on failure.
//
// EXCEPT from a machine pass (any BIGBRAIN_ROLE): the spool carries the
// USER's demand — what their agents went looking for — and a pass's own
// searches are the machinery working, not unmet need. The editor
// searches to decide where to file ("does this dossier exist yet?",
// "where is the typo line?"); memory already sees those same arrivals
// through the ledger cursor, so spooling the whys double-counts one
// arrival as N observations and drowns the real signal (Nick,
// 2026-08-06: two web clips produced five whys, and every observation
// the spool had ever carried was host machinery). The memory pass is
// the same disease one turn worse — the consumer filing its own demand
// makes every run schedule the next (found live 2026-08-05: the first
// forced sweep's own "finding what the record holds" why respooled 18s
// into the run).
//
// Intent keeps its door. A pass with something deliberate to tell
// memory — an entity rename that leaves memory/ links dangling, a tree
// only that pass can repair — still calls `bigbrain observe`. Exhaust
// is closed; a considered signal is not.
if (why && role) {
  console.error(
    `search: why noted but not spooled — the ${role} pass is machinery, not demand; ` +
      "`bigbrain observe` is the deliberate door to memory"
  );
} else if (why) {
  // Fail-soft on the SEARCH, never quiet about the loss: this is the one
  // door whose failure nobody notices — a dropped why costs no exit code
  // and no missing output (issue #43).
  try {
    const { landVoice } = await import("../lib/voice");
    const { userInfo } = await import("node:os");
    landVoice(
      root,
      { kind: "observation", text: why, ...(query ? { query } : {}) },
      { from: userInfo().username || "local", via: "cli:search" },
      { idPrefix: "cli" }
    );
  } catch (e) {
    console.error(
      `search: why not spooled (${e instanceof Error ? e.message : e}) — search unaffected`
    );
  }
}

if (json) {
  console.log(JSON.stringify(hits, null, 2));
  process.exit(0);
}

if (!hits.length) {
  console.error(`search: no matches for "${query}"`);
  process.exit(0);
}

for (const h of hits) {
  console.log(h.date ? `${h.title}  (${h.date})` : h.title);
  console.log(`  ${h.path}`);
  const snip = h.snippet.replace(/\s+/g, " ").trim();
  if (snip) console.log(`  ${snip}`);
  console.log();
}
