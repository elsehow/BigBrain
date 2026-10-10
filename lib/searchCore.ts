/**
 * searchCore.ts — the one search scan every product door runs (#259, #476):
 * the same projection query, result cap, ledger write, and failure posture
 * for `/v1/search`, `/api/search`, and `bigbrain search`.
 *
 * The assertion projection indexes sources, assertions and entities.
 * Current memory files are searched alongside it, without turning derived
 * summaries into record events. Ingestion searches stay record-only.
 * The legacy markdown FTS index retired with the editor pass (#498).
 *
 * Both doors retain only their transport policy: the API rejects an empty
 * query while the viewer treats it as an emptied omnibox. Page-size
 * defaults also remain per client.
 */
import { withVaultSnapshot } from "./vaultReadModel";

import { compactName, nameWords } from "./searchNames";
import { recordSearch, type RetrievalVia } from "./retrieval";
import {
  assertionsWithRefsForEntity,
  projectedSourceHeads,
  searchAssertionEntities,
  searchAssertionProjection,
  searchAssertionSources,
  sourceMatchWindows,
  sourceRefsForAssertions,
  type SourceHead,
} from "./assertionProjection";
import { assertionEntityPath } from "./assertionEntityView";
import { insertionEventOnDisk, insertionEventRel, sourceMoment } from "./insertionLog";
import { isVoiceKind } from "./voiceFacts";
import { searchAlternatives, SearchQueryError } from "./searchQuery";
import { searchMemory } from "./searchMemory";

// ── the wire shapes (owned here since #495) ─────────────────────────────────

export interface SearchHit {
  source?: string;
  /** Memory is a derived summary; agent conversations/answers need their
   * underlying evidence checked. Unmarked hits are record sources/entities. */
  evidence?: "memory" | "agent-conversation" | "agent-answer";
  path: string; // vault-relative
  title: string;
  snippet: string;
  score: number; // lower is a better match
  date: string; // YYYY-MM-DD; "" when the source carries no date
  /** Source hits only: when it is from, to the minute when known (sourceMoment). */
  at?: string;
  /** Entity hits only: how many assertions the record holds on it — the
   * evidence a reader weighs when two entities share a name (Evan Keller 100
   * vs a first-name stub Evan 2). Absent on source hits. */
  assertions?: number;
  /** Entity hits only: the alias label the query met when the entity's own
   * label did not — the result reads "Ridgeways → Auto-MAP" (#728). */
  alias?: string;
}

/** Date-window and type filters (#349) — every search door shares one
 * meaning: `after`/`before` are inclusive YYYY-MM-DD bounds against the
 * hit's `date`, `type` narrows to the record's two shapes. Callers
 * validate format. */
export interface SearchFilters {
  source?: string;
  after?: string;
  before?: string;
  type?: "reference" | "entity";
}

/** A hit with its ranking facts — the ledger's shape (#359). */
export interface RankedHit extends SearchHit {
  /** 0 exact-name, 1 name-prefix, 2 body match. */
  tier: 0 | 1 | 2;
  entity: boolean;
}

/** The one relaxation rung (#361): all-terms first, any-term on zero hits. */
export type Relaxation = "any-term";

/** The one result cap, both doors (#259: unified at 250 — the viewer's
 * ceiling; the API's rises from 100). */
export const SEARCH_CAP = 250;

/** Clamp a door's ?n / ?limit to [1, cap]; garbage and absence fall back to
 * the door's own default. SEARCH_CAP is the ceiling for a SEARCH, which is
 * most callers; the viewer's two feed routes are not searches and carry
 * their own (the work view's due set pages at 500), and they hand-rolled
 * this same expression rather than say so (#639). */
export function clampLimit(raw: string | null, fallback: number, cap = SEARCH_CAP): number {
  return Math.max(1, Math.min(cap, Number(raw ?? fallback) || fallback));
}

export type ScanResult =
  | { ok: true; hits: SearchHit[]; relaxation: Relaxation | null; applied_filters: SearchFilters; only_agent_records: boolean }
  | { ok: false; reason: string; invalid_query?: boolean };

const queryTerms = (value: string): string[] => searchAlternatives(value).flat();

function titleTier(query: string, title: string): 0 | 1 | 2 {
  return Math.min(...searchAlternatives(query).map(q => titleTermsTier(q, title)), 2) as 0 | 1 | 2;
}
function titleTermsTier(q: string[], title: string): 0 | 1 | 2 {
  q = nameWords(q.join(" "));
  const name = nameWords(title);
  if (q.length && compactName(q.join(" ")) === compactName(title)) return 0;
  if (q.length && q.join(" ") === name.join(" ")) return 0;
  if (q.length && q.every((term) => name.some((word) => word.startsWith(term)))) return 1;
  return 2;
}

/** An entity label's tier: every query term a WHOLE word of the label is
 * the top tier whether or not the label has more words — "Evan" names Evan
 * Keller as exactly as it names a stub called Evan, and the evidence count
 * decides between them (the sort below), not the label's length. Before
 * this, the exact-title rule ranked a 6-assertion first-name stub above the
 * 415-assertion person for every bare-name query, and the intake agent
 * linked what it was handed (docs/plans/2026-08-29-entity-aliases.md). */
function entityTier(query: string, label: string): 0 | 1 | 2 {
  return Math.min(...searchAlternatives(query).map(q => entityTermsTier(q, label)), 2) as 0 | 1 | 2;
}
function entityTermsTier(q: string[], label: string): 0 | 1 | 2 {
  q = nameWords(q.join(" "));
  const name = nameWords(label);
  if (q.length && compactName(q.join(" ")) === compactName(label)) return 0;
  if (q.length && q.every((term) => name.includes(term))) return 0;
  if (q.length && q.every((term) => name.some((word) => word.startsWith(term)))) return 1;
  return 2;
}

function sourceDate(source: SourceHead): string {
  return sourceMoment(source).slice(0, 10);
}

const assertionSnippet = (text: string): string => text
  .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/gu, "$1")
  .replace(/\[\[([^\]]+)\]\]/gu, "$1");

/** A body hit's snippet: the projection's match window (sourceMatchWindows),
 * whitespace collapsed and capped like every other snippet. */
const bodySnippet = (window: string): string => window.trim().replace(/\s+/gu, " ").slice(0, 240);

function assertionRanked(
  root: string,
  q: string,
  limit: number,
  filters: SearchFilters,
  mode: "all" | "any"
): RankedHit[] {
  return withVaultSnapshot(root, db => {
    const pool = Math.max(limit * 4, 100);
    // Bodies are prefix-searched from two letters. "r"* matches every source
    // there is, ranks them by nothing a reader would recognise, and was the
    // most expensive scan the omnibox could fire; entities and claims still
    // answer at one letter — "R" is Rowan, Ridgeways — so the box is never
    // blank while the second letter lands.
    const bodies = filters.type !== "entity" && queryTerms(q).some((term) => term.length >= 2);
    const sourceHits = bodies ? searchAssertionSources(root, q, pool, mode, db, filters) : [];
    const assertionHits = !filters.type && !filters.source ? searchAssertionProjection(root, q, pool, mode, db) : [];
    const entityHits = filters.type !== "reference" && !filters.source ? searchAssertionEntities(root, q, pool, mode, db) : [];
    const assertionRefs = sourceRefsForAssertions(root, assertionHits.map((row) => row.id), db);
    // Newest-first and pool-bounded per entity: a heavily-cited entity ranks
    // by its label match, not by fanning out into its complete history.
    const entityRows = entityHits.map((entity) =>
      [entity, assertionsWithRefsForEntity(root, entity.id, pool, db)] as const);

    // An insertion id names its source outright. The FTS index holds titles
    // and bodies, never ids, so an agent handed `ins_…` (a desktop started
    // about a source) found nothing and went looking on disk.
    const named = new Set(q.match(/\bins_[a-f0-9]{24}\b/gu) ?? []);
    const wanted = new Set<string>(named);
    for (const row of sourceHits) wanted.add(row.insertion_id);
    for (const refs of assertionRefs.values()) for (const ref of refs) wanted.add(ref.insertion_id);
    for (const [, rows] of entityRows) for (const row of rows) for (const ref of row.refs) wanted.add(ref.insertion_id);
    const byInsertion = projectedSourceHeads(root, [...wanted], db);
    // A hit whose event has left the log is not a hit. The projection is
    // append-only sync — it adds every new event file and prunes nothing —
    // so a retraction commit (the vault's own `record: retract 9 agent-chat
    // captures…`) leaves the row, its FTS text and its title behind, and
    // search answered with a path `/v1/note` could not open. One stat per
    // unique insertion in the pool keeps the promise the doors owe each
    // other: search never names a path the note door refuses.
    for (const [id, source] of byInsertion)
      if (!insertionEventOnDisk(root, source)) byInsertion.delete(id);

    // `insertion` only on body candidates (kind 3): the row whose window the
    // snippet is cut from, once the hit has actually made the response.
    // `voice` sinks a candidate below every record hit (the sort below).
    type Candidate = RankedHit & { kind: 0 | 1 | 2 | 3; insertion?: string; voice?: boolean; named?: boolean };
    const candidates: Candidate[] = [];
    const eligible = (source: SourceHead): boolean => {
      const date = sourceDate(source);
      return (!filters.after || date >= filters.after) && (!filters.before || date <= filters.before);
    };
    const add = (source: SourceHead, hit: Omit<Candidate, "path" | "title" | "date">): void => {
      if (!eligible(source)) return;
      candidates.push({
        ...hit,
        path: insertionEventRel(source),
        title: source.title,
        ...(source.source ? { source: source.source } : {}),
        date: sourceDate(source),
        ...(sourceMoment(source) ? { at: sourceMoment(source) } : {}),
        ...(source.kind === "handoff-answer" ? { evidence: "agent-answer" as const } :
          ["agent-chat", "pilot-chat"].includes(source.kind ?? "") || ["agent-chat", "pilot"].includes(source.source ?? "")
            ? { evidence: "agent-conversation" as const } : {}),
        // A voice arrival (a directive, a request) is the user's words ABOUT
        // the record — honest evidence for the assertion that settles it, but
        // never a better answer than the record itself. #633 dropped it here
        // outright, which also dropped every assertion whose ONLY source is
        // voice: on the live vault that hid five of the 2026-08-31
        // corrections, `resolved-by-correction` matching an assertion in
        // `assertion_fts` and returning nothing (#641). Ranking, not
        // existence, is what "all eyes" needed: the clip still wins.
        ...(isVoiceKind(source.kind) ? { voice: true } : {}),
      });
    };

    for (const id of named) {
      const source = byInsertion.get(id);
      if (source) add(source, { snippet: "", score: 0, tier: 0, entity: false, kind: 3, insertion: id, named: true });
    }

    for (const row of sourceHits) {
      const source = byInsertion.get(row.insertion_id);
      if (!source) continue;
      add(source, {
        snippet: "", // cut below, for the body hits that survive dedupe
        score: row.score,
        tier: titleTier(q, source.title),
        entity: false,
        kind: 3,
        insertion: row.insertion_id,
      });
    }

    for (const row of assertionHits) {
      for (const ref of assertionRefs.get(row.id) ?? []) {
        const source = byInsertion.get(ref.insertion_id);
        if (!source) continue;
        add(source, {
          snippet: assertionSnippet(row.text),
          score: row.score,
          tier: 2,
          entity: false,
          kind: 2,
        });
      }
    }

    for (const [entity, rows] of entityRows) {
      // The entity ITSELF is the first hit — the projection note both note
      // doors serve. Fanning a label match out into only its cited sources
      // left the product search unable to answer "Ada" with Ada while the
      // intake agent's private tools could. Its date is its newest evidence,
      // so `after:`/`before:` keep meaning "entities with activity then".
      const newestDate = (rows[0]?.refs ?? [])
        .map((ref) => { const s = byInsertion.get(ref.insertion_id); return s ? sourceDate(s) : ""; })
        .reduce((a, b) => (b > a ? b : a), "");
      if ((!filters.after || newestDate >= filters.after) &&
          (!filters.before || !newestDate || newestDate <= filters.before))
        candidates.push({
          path: assertionEntityPath(entity.id),
          title: entity.label,
          snippet: rows[0] ? assertionSnippet(rows[0].text) : entity.label,
          score: entity.score,
          // the label the query met decides the tier: "Auto-MAP" typed and
          // Auto-MAP met is an exact hit, whatever the entity is called now
          tier: entityTier(q, entity.alias ?? entity.label),
          date: newestDate,
          entity: true,
          assertions: entity.assertions,
          ...(entity.alias ? { alias: entity.alias } : {}),
          kind: 0,
        });
      for (const row of rows) {
        for (const ref of row.refs) {
          const source = byInsertion.get(ref.insertion_id);
          if (!source) continue;
          add(source, {
            snippet: assertionSnippet(row.text),
            score: entity.score,
            tier: entityTier(q, entity.alias ?? entity.label),
            entity: true,
            assertions: entity.assertions,
            kind: 1,
          });
        }
      }
    }

    // Voice last, whatever it scored: a directive titled with the words the
    // reader just typed out-tiers the clip it was typed beside, and the
    // record is the better answer whenever there is one. Then, within a tier
    // and kind, evidence before label score: the entity the record cites most
    // is the one a bare name most likely means.
    candidates.sort((a, b) =>
      Number(!a.named) - Number(!b.named) ||
      Number(a.voice ?? false) - Number(b.voice ?? false) ||
      Number(!!a.evidence) - Number(!!b.evidence) ||
      a.tier - b.tier || a.kind - b.kind || (b.assertions ?? 0) - (a.assertions ?? 0) ||
      a.score - b.score || a.path.localeCompare(b.path)
    );
    // One path, one hit — and the hit wears the best-ranked CLAIM about that
    // source when any assertion matched, whichever candidate won the rank.
    // Rank and snippet are separate questions: a transcript titled
    // "Claude Code — BigBrain (…)" title-matches every query naming the
    // project, so its body candidate outranks its own assertions at this
    // dedupe; before this the winner answered with the body's opening line
    // (the session header) and the assertion the projection had already
    // extracted was computed, then discarded.
    const claimByPath = new Map<string, string>();
    for (const hit of candidates)
      if ((hit.kind === 1 || hit.kind === 2) && !claimByPath.has(hit.path)) claimByPath.set(hit.path, hit.snippet);
    const seen = new Set<string>();
    const unique: Candidate[] = [];
    for (const hit of candidates) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      unique.push(hit.kind === 3 ? { ...hit, snippet: claimByPath.get(hit.path) ?? hit.snippet } : hit);
      if (unique.length === limit) break;
    }
    // Body windows last, for only the hits that reached the response with no
    // claim to wear — at most `limit` rows, usually far fewer — instead of
    // one per row the prefix matched.
    const windows = sourceMatchWindows(
      root, unique.flatMap((hit) => (hit.kind === 3 && !hit.snippet && hit.insertion ? [hit.insertion] : [])), q, db);
    // The count is the ENTITY hit's fact; a source row an entity's assertion
    // reached through carries no count of its own.
    return unique.map(({ kind, insertion, assertions, voice: _voice, named: _named, ...hit }) => {
      const ranked = kind === 0 ? { ...hit, assertions } : hit;
      return kind === 3 && !hit.snippet
        ? { ...ranked, snippet: bodySnippet(windows.get(insertion ?? "") ?? "") || hit.title }
        : ranked;
    });
  });
}

/** The per-door knobs the shared scan takes beside its four-argument core
 * (root, query, limit, door). Every one of them is a default a door may
 * decline to state, so they ride in one bag rather than as a positional
 * tail — the CLI used to pass `undefined` through two slots to reach the
 * last one. `ledger: false` is the CLI's machine-pass door (BIGBRAIN_ROLE
 * set): a pass searching to decide where to file is the machinery working,
 * not a person looking for something, and lib/retrieval.ts's bench must not
 * learn it as demand. */
export interface ScanOptions {
  /** Read clock — the ledger's timestamp. Defaults to now at record time. */
  now?: Date;
  /** Date/type narrowing the door parsed from its query string. */
  filters?: SearchFilters;
  /** Fall back to the any-term rung when every term together finds
   * nothing (#361). On by default; the machine pass turns it off. */
  relax?: boolean;
  ledger?: boolean;
  includeMemory?: boolean;
}

/** One product search over the assertion projection. Every door —
 * `/v1/search`, `/api/search`, and `bigbrain search` (#476) — is this one
 * function, so an agent on the CLI sees exactly what the same agent sees
 * over HTTP. */
export function scanSurface(
  root: string,
  q: string,
  limit: number,
  via: RetrievalVia,
  opts: ScanOptions = {}
): ScanResult {
  const { now, filters = {}, relax = true, ledger = true, includeMemory = via !== "gardener" } = opts;
  try {
    searchAlternatives(q); // validate before touching the projection
    // Notes are current as their door projected them (projectNotes).
    return withVaultSnapshot(root, () => {
      const ranked = (mode: "all" | "any"): RankedHit[] => {
        const record = assertionRanked(root, q, limit, filters, mode);
        const memory = includeMemory ? searchMemory(root, q, filters, mode) : [];
        // Keep the established record order. Memory is the curated working
        // set, so offer it before body matches and conversation echoes, while
        // exact/prefix record names still beat unrelated memory body matches.
        const merged = [...record];
        memory.sort((a, b) => a.tier - b.tier || Number(a.path === "memory/MEMORY.md") - Number(b.path === "memory/MEMORY.md") || a.path.localeCompare(b.path));
        for (const hit of memory) {
          const at = merged.findIndex(existing => existing.evidence === "agent-conversation" || existing.evidence === "agent-answer" ||
            existing.tier > hit.tier || (existing.tier === hit.tier && existing.evidence !== "memory"));
          merged.splice(at < 0 ? merged.length : at, 0, hit);
        }
        return merged.slice(0, limit);
      };
      let hits = ranked("all");
      let relaxation: Relaxation | null = null;
      if (!hits.length && relax && queryTerms(q).length > 1) {
        hits = ranked("any");
        if (hits.length) relaxation = "any-term";
      }
      if (ledger) recordSearch(root, q, hits, via, now, relaxation ?? undefined);
      return {
        ok: true,
        hits: hits.map(({ path, title, snippet, score, date, assertions, alias, source, evidence }) => ({
          path, title, snippet, score, date, ...(assertions === undefined ? {} : { assertions }),
          ...(alias ? { alias } : {}),
          ...(source ? { source } : {}),
          ...(evidence ? { evidence } : {}),
        })),
        relaxation,
        applied_filters: { ...filters },
        only_agent_records: hits.length > 0 && hits.every(h => h.evidence === "agent-conversation" || h.evidence === "agent-answer"),
      };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), ...(error instanceof SearchQueryError ? { invalid_query: true } : {}) };
  }
}
