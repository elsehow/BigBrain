/**
 * retrieval.ts — the RETRIEVAL LEDGER: what was searched for, and what was
 * read afterwards.
 *
 * BigBrainBench needs labels, and labels need human judgment. The vault has
 * almost none: 12 human commits touch `references/` 290 times and
 * `entities/` ZERO times, so "the user corrects the filing" — the obvious
 * label source — has never once happened (#177). The only human signal in
 * the system today is the 13 directives carrying `guidance`.
 *
 * This is the second source, and it is free. When a search is followed by a
 * read of one of its hits, that pair is a relevance judgment nobody had to
 * make deliberately: the user's agent looked for something, was shown a
 * ranked list, and picked. A search whose hits are never opened is the
 * NEGATIVE example, and it is the more valuable of the two — it is the only
 * evidence we get that retrieval failed.
 *
 * Three decisions worth stating, because each has an obvious wrong version:
 *
 * 1. THE LEDGER LIVES IN THE VAULT, NOT IN TELEMETRY. A query string is
 *    content — "rrsp contribution room" says what someone is dealing with —
 *    and only names and counts ever leave the box. The vault is the
 *    user's own git repo, so their labels stay in their own repo — also
 *    the moat argument: the corpus is someone's life and cannot be copied.
 *
 * 2. THE WRITER IS DUMB; THE JOIN IS OFFLINE. We append two independent
 *    record kinds and attribute use→search later, in `labels()`. Doing the
 *    attribution at write time would bake today's guess about the window
 *    into data we cannot re-derive. The record must outlive the analysis.
 *
 * 3. MACHINE SEARCHES ARE NOT DEMAND. The editor searches to decide where
 *    to file; the memory pass searches its own record. Neither is a person
 *    looking for something, and both would swamp the real signal — exactly
 *    the failure the observation spool already hit (bin/search.ts: two web
 *    clips produced five whys, all of them host machinery). Callers pass
 *    `via`, and machine passes do not call at all.
 *
 * KNOWN BIAS, stated because a number nobody can interpret is worse than no
 * number: a USE is observable through the HTTP doors and, where the vault
 * scaffold's Read hook is installed (#359, deploy/vault-template), through
 * an agent's own file reads (`bigbrain use`, via: "cli"). A vault without
 * the hook still records CLI searches with no observable use — so
 * `summary()` keeps `via: "cli"` SEARCHES out of the scored denominator,
 * while a cli USE joins freely: an agent is one surface whichever door it
 * came through (see `surface()`), and the hook-recorded read after an HTTP
 * search was exactly the blind spot #359 closed.
 */

import { noRetrievalLog } from "./env";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Where the search came from. Determines whether a USE is observable at
 * all — see the header's bias note. */
export type RetrievalVia = "api" | "cli" | "web" | "gardener";

/** The join surface (#359): `api` and `cli` are the same agent reaching
 * through different doors — an HTTP search followed by a hook-recorded
 * file read is ONE person's retrieval. `web` stays its own surface: a UI
 * click is a different reader with different intent. `gardener` is its
 * own surface too, the other way around: machine traffic (#502, the tend
 * runner's searches and reads) may join only itself, never a person's
 * demand. */
export function surface(via: RetrievalVia): "agent" | "web" | "gardener" {
  if (via === "web") return "web";
  if (via === "gardener") return "gardener";
  return "agent";
}

export interface SearchRecord {
  t: "search";
  at: string;
  via: RetrievalVia;
  /** The query as issued. Content — vault-only, never telemetry. */
  q: string;
  /** Vault-relative hit paths in RANK ORDER; position is the label. */
  hits: string[];
  /** Launcher tier per hit, parallel to `hits` (the retired markdown search's nameTier:
   * 0/1 = the query named the note, 2 = a body match). Raw fact recorded
   * at write time so `labels()` can tell a name check answered by the
   * list from a miss (#359); absent on records that predate it. */
  tiers?: (0 | 1 | 2)[];
  /** Present when the exact scan answered nothing and the hits came from
   * a relaxation rung instead (#361, the retired markdown search's searchRelaxed). Its
   * presence IS the raw zero-hit fact: `hits` holds the relaxed answer,
   * so the pre-#361 zero-hit rate reads as `relaxation || !hits.length`. */
  relaxation?: "any-term";
}

export interface UseRecord {
  t: "use";
  at: string;
  via: RetrievalVia;
  /** Vault-relative path that was fetched. */
  path: string;
}

export type RetrievalRecord = SearchRecord | UseRecord;

/** Monthly files: small enough to read whole, coarse enough that a busy
 * vault does not accumulate a directory of thousands. */
export function ledgerRel(at: Date): string {
  return `journal/retrieval/${at.toISOString().slice(0, 7)}.jsonl`;
}

/** True for a path inside the ledger's directory, under either separator.
 * The viewer's vault watcher must ignore these: the ledger is the read
 * path's own exhaust (/api/note appends a `use` on every read), so a change
 * ping for it hands every open note view its own echo — read → ping →
 * refetch → read, for as long as the tab is open. */
export function isLedgerPath(rel: string): boolean {
  const [a, b] = rel.split(/[/\\]/);
  return a === "journal" && b === "retrieval";
}

/** A query longer than this is a paste accident or an attack, not a search;
 * a hit list longer than this is a `--limit 100` sweep whose tail nobody
 * looked at. Both are clipped so one call cannot bloat the ledger. */
const MAX_Q = 512;
const MAX_HITS = 20;

/** Opt-out. The ledger holds queries, so the switch has to exist; a
 * `vault.yaml` key can front this later without changing callers. */
function disabled(): boolean {
  return noRetrievalLog();
}

/**
 * Append one record. FAIL-SOFT, always: a lost label costs a benchmark row,
 * and a thrown error costs the user their search. The trade is not close.
 */
function append(root: string, rec: RetrievalRecord): void {
  if (disabled()) return;
  try {
    const abs = join(root, ledgerRel(new Date(rec.at)));
    mkdirSync(dirname(abs), { recursive: true });
    // One write of one line: POSIX append is atomic at this size, which is
    // what lets the api server, the web server and the CLI share a file
    // without a lock.
    appendFileSync(abs, `${JSON.stringify(rec)}\n`, "utf8");
  } catch {
    /* the header's promise */
  }
}

/** Record a query and what it returned. No-op on an empty query. Hits
 * that carry a launcher tier get it persisted (see SearchRecord.tiers);
 * plain paths write the pre-#359 shape. */
export function recordSearch(
  root: string,
  q: string,
  hits: readonly { path: string; tier?: 0 | 1 | 2 }[] | readonly string[],
  via: RetrievalVia,
  now: Date = new Date(),
  relaxation?: "any-term"
): void {
  const query = (q ?? "").trim().slice(0, MAX_Q);
  if (!query) return;
  const clipped = [...hits].slice(0, MAX_HITS);
  const paths = clipped.map((h) => (typeof h === "string" ? h : h.path));
  const rec: SearchRecord = { t: "search", at: now.toISOString(), via, q: query, hits: paths };
  const tiers = clipped.map((h) => (typeof h === "string" ? undefined : h.tier));
  if (tiers.length && tiers.every((t) => t !== undefined)) rec.tiers = tiers as (0 | 1 | 2)[];
  if (relaxation) rec.relaxation = relaxation;
  append(root, rec);
}

/**
 * The read hook's filter (#359): map an absolute or vault-relative path to
 * its vault-relative form IF it names a content note the search surface can
 * cite — the legacy trees (references/, entities/) and the native ones
 * (projection/ entity pages, log/ source paths — virtual over HTTP, but
 * exactly the strings search hits carry, so a recorded use can join a
 * search label; #502 closed the native blind spot). Anything else
 * (memory/, the journal, code, paths outside the vault) answers null and
 * stays off the ledger.
 */
const CONTENT_TREES = new Set(["references", "entities", "projection", "log"]);
export function contentUseRel(root: string, p: string): string | null {
  const trimmed = (p ?? "").trim();
  if (!trimmed) return null;
  const abs = isAbsolute(trimmed) ? trimmed : join(root, trimmed);
  const rel = relative(root, abs).split(sep).join("/");
  if (rel.startsWith("..") || !rel.endsWith(".md")) return null;
  const tree = rel.split("/")[0];
  return tree && CONTENT_TREES.has(tree) ? rel : null;
}

/** Record that a path was fetched. Most of these attribute to no search —
 * following a wikilink is not retrieval — and `labels()` drops those. */
export function recordUse(
  root: string,
  path: string,
  via: RetrievalVia,
  now: Date = new Date()
): void {
  const p = (path ?? "").trim();
  if (!p) return;
  append(root, { t: "use", at: now.toISOString(), via, path: p });
}

// ── reading, and the join ───────────────────────────────────────────────────

/** Every record on disk, oldest first. Unparseable lines are skipped: a
 * torn tail from a killed process must not cost the whole month. */
export function readLedger(root: string): RetrievalRecord[] {
  const dir = join(root, "journal", "retrieval");
  if (!existsSync(dir)) return [];
  const out: RetrievalRecord[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as RetrievalRecord;
        if (r && (r.t === "search" || r.t === "use") && typeof r.at === "string") out.push(r);
      } catch {
        /* torn line */
      }
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** One labeled retrieval: a query, what it showed, and what got opened. */
export interface RetrievalLabel {
  at: string;
  via: RetrievalVia;
  q: string;
  /** Hits shown, in rank order. */
  shown: string[];
  /** Of those, the ones subsequently fetched — deduped, first-fetch order. */
  used: string[];
  /** Rank of the first used hit, 1-based; 0 when nothing was used. The
   * cheapest possible retrieval metric: mean reciprocal rank falls straight
   * out of this column. */
  firstUsedRank: number;
  /** Launcher tier of the top hit; null when the record predates tiers. */
  topTier: 0 | 1 | 2 | null;
  /** What became of the search (#359). `acted`: a hit was opened.
   * `answeredByList`: nothing opened, but the top hit was a name match —
   * an existence check the result list itself answered (a CANDIDATE
   * class: inferred, not observed). `seenRecently`: nothing opened, but a
   * shown hit was read just before the search — it was already in the
   * reader's hands. `miss`: the honest failure, the one #177 mines. */
  outcome: "acted" | "answeredByList" | "seenRecently" | "miss";
  /** The rung that produced `shown`, when the exact scan answered nothing
   * (#361); null for an exact answer. Non-null implies the raw zero-hit. */
  relaxation: "any-term" | null;
}

/** How long after a search a read still counts as caused by it. Thirty
 * minutes is generous on purpose — an agent that searches, thinks, and then
 * reads is the case we most want to capture, and a false positive costs one
 * noisy label while a false negative silently deletes the signal. */
export const USE_WINDOW_MS = 30 * 60_000;

/** How close together two searches must be for the shorter to read as
 * typing rather than asking. The web omnibox debounces at 150ms and fires
 * on every pause, so "ric" → "rich sut" → "rich sutton" arrives as three
 * searches of which only the last is a question anybody asked. */
export const TYPEAHEAD_MS = 5_000;

/**
 * Drop searches that were superseded by a longer query moments later from
 * the same surface — the prefixes a person typed on the way to what they
 * meant. Done at READ time so the raw keystroke record survives: if this
 * rule turns out to be wrong, the data to re-derive it is still on disk.
 */
export function collapseTypeahead(
  records: readonly RetrievalRecord[],
  windowMs: number = TYPEAHEAD_MS
): RetrievalRecord[] {
  const searches = records.filter((r): r is SearchRecord => r.t === "search");
  const dead = new Set<SearchRecord>();
  for (const s of searches) {
    const ms = Date.parse(s.at);
    for (const t of searches) {
      if (t === s || t.via !== s.via) continue;
      const tms = Date.parse(t.at);
      if (tms <= ms || tms - ms > windowMs) continue;
      if (t.q.length > s.q.length && t.q.toLowerCase().startsWith(s.q.toLowerCase())) dead.add(s);
    }
  }
  return records.filter((r) => r.t !== "search" || !dead.has(r));
}

/**
 * Attribute uses to searches. A use joins the MOST RECENT preceding search
 * from the same surface whose hit list contains the path, inside the
 * window. Same-surface is required because a UI click and an agent's fetch
 * are different people doing different things, and crossing them would
 * invent labels neither produced — but `api` and `cli` are ONE surface
 * (see `surface()`): the same agent searching through a door and reading
 * through the hook.
 */
export function labels(
  records: readonly RetrievalRecord[],
  windowMs: number = USE_WINDOW_MS
): RetrievalLabel[] {
  const ordered = collapseTypeahead(records).sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0
  );
  const out: RetrievalLabel[] = [];
  const open: { label: RetrievalLabel; ms: number; hits: Set<string> }[] = [];
  /** Uses inside the trailing window, kept so a search can see what its
   * reader had ALREADY read — the `seenRecently` outcome. */
  const recent: { ms: number; path: string; s: ReturnType<typeof surface> }[] = [];
  const seenBefore = new Set<RetrievalLabel>();
  for (const r of ordered) {
    const ms = Date.parse(r.at);
    if (Number.isNaN(ms)) continue;
    while (recent.length && ms - recent[0]!.ms > windowMs) recent.shift();
    if (r.t === "search") {
      const label: RetrievalLabel = {
        at: r.at,
        via: r.via,
        q: r.q,
        shown: r.hits,
        used: [],
        firstUsedRank: 0,
        topTier: r.tiers?.[0] ?? null,
        outcome: "miss",
        relaxation: r.relaxation ?? null,
      };
      if (r.hits.some((h) => recent.some((u) => u.s === surface(r.via) && u.path === h)))
        seenBefore.add(label);
      out.push(label);
      open.unshift({ label, ms, hits: new Set(r.hits) });
      continue;
    }
    recent.push({ ms, path: r.path, s: surface(r.via) });
    // newest-first, so the first match IS the most recent one
    const hit = open.find(
      (o) => surface(o.label.via) === surface(r.via) && ms - o.ms <= windowMs && o.hits.has(r.path)
    );
    if (!hit || hit.label.used.includes(r.path)) continue;
    hit.label.used.push(r.path);
    if (!hit.label.firstUsedRank) hit.label.firstUsedRank = hit.label.shown.indexOf(r.path) + 1;
  }
  for (const l of out) {
    l.outcome = l.used.length
      ? "acted"
      : l.topTier !== null && l.topTier <= 1
        ? "answeredByList"
        : seenBefore.has(l)
          ? "seenRecently"
          : "miss";
  }
  return out;
}

/** Headline numbers over a label set. Deliberately few: these are the ones
 * a model comparison can move, and every extra column is one more thing to
 * keep true. `hitRate` keeps its pre-#359 meaning (acted / scored) so runs
 * stay comparable across the change; the honest rate excludes the two
 * non-demand outcomes and is acted / (acted + misses). */
export function summary(ls: readonly RetrievalLabel[]): {
  searches: number;
  withUse: number;
  hitRate: number;
  mrr: number;
  zeroResult: number;
  answeredByList: number;
  seenRecently: number;
  misses: number;
  /** Scored searches whose exact scan answered nothing and the relaxation
   * rung answered instead (#361). `zeroResult + relaxed` is the pre-#361
   * zero-hit rate, comparable across the change. */
  relaxed: number;
} {
  const scored = ls.filter((l) => l.via !== "cli" && l.via !== "gardener");
  const withUse = scored.filter((l) => l.used.length).length;
  const mrr = scored.length
    ? scored.reduce((n, l) => n + (l.firstUsedRank ? 1 / l.firstUsedRank : 0), 0) / scored.length
    : 0;
  return {
    searches: ls.length,
    withUse,
    hitRate: scored.length ? withUse / scored.length : 0,
    mrr,
    zeroResult: ls.filter((l) => !l.shown.length).length,
    answeredByList: scored.filter((l) => l.outcome === "answeredByList").length,
    seenRecently: scored.filter((l) => l.outcome === "seenRecently").length,
    misses: scored.filter((l) => l.outcome === "miss").length,
    relaxed: scored.filter((l) => l.relaxation !== null).length,
  };
}

// ── heat: per-note demand ───────────────────────────────────────────────────

export interface HeatRow {
  path: string;
  reads: number;
  /** ISO timestamp of the most recent read. */
  lastAt: string;
}

export interface HeatTreeRow {
  tree: string;
  reads: number;
}

export interface HeatSummary {
  /** ISO window start, or null when the whole ledger was counted. */
  since: string | null;
  /** Every read path in the window, most-read first. */
  notes: HeatRow[];
  /** Reads rolled up by top-level tree ("entities", "domains", …; "." for
   * files at the vault root), most-read first. */
  trees: HeatTreeRow[];
}

/**
 * Heat is NOT a label set. `labels()` drops a use it cannot attribute to a
 * search, because an unattributed use is no evidence about the INDEX — but
 * it is still someone wanting that note, which is exactly what a scheduler
 * or an econ report needs (#323). So heat counts every use in the window,
 * wikilink-follows and direct opens included.
 *
 * Inherited bias, restated: only the HTTP doors write uses, so agent reads
 * after a CLI search are invisible and heat under-counts them.
 */
export function heat(records: readonly RetrievalRecord[], since?: Date): HeatSummary {
  // An Invalid Date (a caller's overflowed or unparseable input) reads as no
  // window — toISOString() on it would throw.
  const cut = since && !Number.isNaN(since.getTime()) ? since.toISOString() : null;
  const byPath = new Map<string, { reads: number; lastAt: string }>();
  for (const r of records) {
    if (r.t !== "use") continue;
    // readLedger admits any line carrying `t` and a string `at`, and every
    // other reader survives that. A pathless or garbage-dated line must lose
    // itself, never the readout — and never poison the window or lastAt.
    if (typeof r.path !== "string" || !r.path) continue;
    if (Number.isNaN(Date.parse(r.at))) continue;
    // The whole journal tree is the system's own exhaust — pass journals,
    // verdicts, and this ledger itself. Agents read it constantly (24% of
    // one prod vault's first 985 uses); none of that is knowledge demand,
    // and ranking the instrument panel as hot notes would poison every
    // consumer (#325). Same separator tolerance as isLedgerPath.
    if (r.path.split(/[/\\]/)[0] === "journal") continue;
    // ISO-8601 strings from toISOString() order lexically.
    if (cut && r.at < cut) continue;
    const row = byPath.get(r.path);
    if (row) {
      row.reads += 1;
      if (r.at > row.lastAt) row.lastAt = r.at;
    } else byPath.set(r.path, { reads: 1, lastAt: r.at });
  }
  const notes: HeatRow[] = [...byPath.entries()]
    .map(([path, v]) => ({ path, reads: v.reads, lastAt: v.lastAt }))
    .sort((a, b) => b.reads - a.reads || (a.path < b.path ? -1 : 1));
  const byTree = new Map<string, number>();
  for (const n of notes) {
    const slash = n.path.indexOf("/");
    const tree = slash === -1 ? "." : n.path.slice(0, slash);
    byTree.set(tree, (byTree.get(tree) ?? 0) + n.reads);
  }
  const trees = [...byTree.entries()]
    .map(([tree, reads]) => ({ tree, reads }))
    .sort((a, b) => b.reads - a.reads || (a.tree < b.tree ? -1 : 1));
  return { since: cut, notes, trees };
}
