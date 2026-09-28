/** MiniSearch owns name/title matching; SQLite remains the record and body index. */
import MiniSearch, { type Query, type SearchResult } from 'minisearch';
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { liveSourceSql } from './sourceSupersede';

type Kind = 'entity' | 'source';
interface NameDocument { id: string; rawId: string; kind: Kind; name: string }
export interface NameHit { id: string; score: number }
const tokenize = MiniSearch.getDefault('tokenize') as (value: string) => string[];
const normalize = (value: string): string => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
export const nameWords = (value: string): string[] => tokenize(normalize(value)).filter(Boolean);
export const compactName = (value: string): string => nameWords(value).join('');

function createIndex(): MiniSearch<NameDocument> {
  return new MiniSearch<NameDocument>({
    fields: ['name', 'compact'], storeFields: ['kind', 'rawId'],
    extractField: (doc, field) => field === 'compact' ? doc.name : doc[field as keyof NameDocument],
    processTerm: normalize,
    tokenize: (value, field) => {
      const words = tokenize(value).filter(Boolean);
      // An additional field indexes joined words, so spacing is optional.
      // MiniSearch still handles every lookup, prefix, typo and relevance score.
      return field === 'compact'
        ? [...new Set([words.join(''), ...words.flatMap((_, i) => [1, 2, 3].map(n => words.slice(i, i + n).join('')))])]
        : words;
    },
    searchOptions: { prefix: true, fuzzy: term => term.length >= 5 && !/\d/u.test(term) ? (term.length >= 6 ? 2 : 1) : false, maxFuzzy: 2, combineWith: 'AND' },
  });
}

interface Cached { db: Database; identity: string; version: number; index: MiniSearch<NameDocument> }
const cache = new Map<string, Cached>();
const versionOf = (db: Database): number => (db.query('PRAGMA data_version').get() as { data_version: number }).data_version;

/** Keep a read-only observer per cached vault: data_version on a freshly
 * opened connection cannot detect another connection's writes. No bodies or
 * assertion text are loaded. A rebuilt DB or any projection write refreshes
 * the names, including aliases, revocations, and superseded sources. */
function indexFor(path: string): MiniSearch<NameDocument> {
  const stat = statSync(path);
  const identity = `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
  let held = cache.get(path);
  if (held && held.identity !== identity) { held.db.close(); cache.delete(path); held = undefined; }
  if (!held) {
    if (cache.size >= 4) {
      const oldest = cache.keys().next().value!;
      cache.get(oldest)!.db.close(); cache.delete(oldest);
    }
    held = { db: new Database(path, {readonly: true}), identity, version: -1, index: createIndex() };
    cache.set(path, held);
  }
  const version = versionOf(held.db);
  if (version !== held.version) {
    const rows = held.db.query(`
      SELECT 'source' AS kind, insertion_id AS rawId, title AS name FROM sources s WHERE ${liveSourceSql('s')}
      UNION ALL SELECT 'entity', id, label FROM entities
      UNION ALL SELECT 'entity', alias_id, alias FROM entity_aliases
    `).all() as Omit<NameDocument, 'id'>[];
    const index = createIndex();
    index.addAll([...new Map(rows.map(row => {
      const id = `${row.kind}:${row.rawId}:${row.name}`;
      return [id, {...row, id}];
    })).values()]);
    held.index = index; held.version = version;
  }
  return held.index;
}

export function searchNames(path: string, query: string, kind: Kind, mode: 'all' | 'any' = 'all', fuzzy = true): NameHit[] {
  if (!nameWords(query).length) return [];
  const compact = compactName(query);
  const queries: Query[] = [{queries: [query], fields: ['name'], combineWith: mode === 'all' ? 'AND' : 'OR'}];
  if (compact.length >= 3) queries.push({queries: [compact], fields: ['compact'], fuzzy: false});
  const index = indexFor(path);
  const expression: Query = {queries, combineWith: 'OR'};
  const filter = (hit: SearchResult): boolean => hit.kind === kind;
  const exact = index.search(expression, {filter, fuzzy: false});
  // Typo tolerance is a fallback, so a successful `Briar` search does not
  // acquire unrelated `Budget` results just because the spellings are close.
  const hits = exact.length || !fuzzy ? exact : index.search(expression, {filter});
  const seen = new Set<string>();
  return hits.filter(hit => { if (seen.has(hit.rawId)) return false; seen.add(hit.rawId); return true; })
    .map(hit => ({id: hit.rawId as string, score: -hit.score}));
}
