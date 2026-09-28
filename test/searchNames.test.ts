import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchNames } from '../lib/searchNames';
import { scanSurface } from '../lib/searchCore';
import { appendSourceInsertionEvent } from '../lib/insertionLog';
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from '../lib/assertionLog';
import { appendAndProjectEntityAlias, syncAssertionProjection } from '../lib/assertionProjection';
import { createEntityAliasEvent } from '../lib/entityAliasLog';
import { insertion } from './support/vault';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); delete process.env.BIGBRAIN_ASSERTION_DB; });

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), 'bb-search-names-')); roots.push(root);
  process.env.BIGBRAIN_ASSERTION_DB = join(root, '.state', 'assertions.db');
  const entity = { id: assertionEntityId(label), label };
  const source = insertion({ id: 'ins_0123456789abcdef01234567', source_id: 'name-test', title: `Discussion — ${label} (2026-09-08)`, body: 'The project was reviewed.', content_sha256: 'test-name' });
  appendSourceInsertionEvent(root, source);
  appendAssertionEvent(root, createAssertionEvent({
    text: `[[${entity.id}|${label}]] was reviewed.`, entities: [entity],
    citations: [{ insertion_id: source.id, quotes: ['project was reviewed'] }],
    author: {kind: 'model', id: 'test', invocation_id: 'name-test'}, confidence: 'direct',
    created_at: '2026-09-08T12:00:00Z', produced_by: {procedure: 'test', version: '1'},
  }, new Map([[source.id, source]])));
  return {root, entity, source};
}

for (const label of ['intake-bench', 'IntakeBench', 'intake bench', 'intake_bench', 'Intaké–Bench']) {
  test(`spacing and punctuation variants retrieve ${label} through shared search`, () => {
    const {root, entity, source} = fixture(label);
    for (const q of ['intake-bench', 'intake bench', 'intakebench', 'intakeben']) {
      const result = scanSurface(root, q, 10, 'web', {filters: {type: 'entity'}});
      if (!result.ok) throw new Error(result.reason);
      expect(result.hits[0]?.path).toBe(`projection/entities/${entity.id}.md`);
      const sources = scanSurface(root, q, 10, 'api', {filters: {type: 'reference'}});
      if (!sources.ok) throw new Error(sources.reason);
      expect(sources.hits.some(h => h.path.endsWith(`${source.id}.json`))).toBe(true);
    }
  });
}

test('joined alias spelling resolves to the canonical dossier once', () => {
  const {root, entity} = fixture('Canonical Project');
  syncAssertionProjection(root);
  appendAndProjectEntityAlias(root, createEntityAliasEvent({alias: 'Intake-Bench', entity,
    author: {kind: 'user', id: 'test'}, created_at: '2026-09-08T13:00:00Z', produced_by: {procedure: 'test', version: '1'},
  }));
  const result = scanSurface(root, 'intakebench', 10, 'web', {filters: {type: 'entity'}});
  if (!result.ok) throw new Error(result.reason);
  expect(result.hits.filter(h => h.path.startsWith('projection/entities/'))).toEqual([
    expect.objectContaining({title: 'Canonical Project', alias: 'Intake-Bench'}),
  ]);
});

test('MiniSearch tolerates a typo and refreshes when an alias is added', () => {
  const {root, entity} = fixture('intake-bench');
  syncAssertionProjection(root);
  const path = join(root, '.state', 'assertions.db');
  expect(searchNames(path, 'intkae bench', 'entity').map(h => h.id)).toContain(entity.id);
  expect(searchNames(path, 'Historical Benchmark', 'entity')).toEqual([]);
  appendAndProjectEntityAlias(root, createEntityAliasEvent({alias: 'Historical Benchmark', entity,
    author: {kind: 'user', id: 'test'}, created_at: '2026-09-08T13:00:00Z', produced_by: {procedure: 'test', version: '1'},
  }));
  expect(searchNames(path, 'historicalbenchmark', 'entity')).toHaveLength(1);
});

test('cached names disappear after revocation and refresh after projection rebuild', async () => {
  const {root, entity} = fixture('Transient Project');
  const {liveAssertionsForEntity, appendAndProjectRevocation, rebuildAssertionProjection} = await import('../lib/assertionProjection');
  const {createRevocationEvent} = await import('../lib/revocationLog');
  syncAssertionProjection(root);
  const path = join(root, '.state', 'assertions.db');
  expect(searchNames(path, 'transientproject', 'entity')).toHaveLength(1);
  const [assertion] = liveAssertionsForEntity(root, entity.id);
  appendAndProjectRevocation(root, createRevocationEvent({assertion_id: assertion!.id, reason: 'test revocation',
    author: {kind: 'user', id: 'test'}, created_at: '2026-09-08T14:00:00Z', produced_by: {procedure: 'test', version: '1'},
  }));
  expect(searchNames(path, 'transientproject', 'entity')).toEqual([]);
  rebuildAssertionProjection(root);
  expect(searchNames(path, 'transientproject', 'entity')).toEqual([]);
  expect(searchNames(path, 'transientproject', 'source')).toHaveLength(1);
});
