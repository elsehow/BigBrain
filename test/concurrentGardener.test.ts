import { fakeIntegrationActivation } from "./support/integrationActivation";
import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { gitVault, insertionSeq, testManifest } from './support/vault';
import { appendSourceInsertionEvent } from '../lib/insertionLog';
import { machineTools } from '../lib/run/machineTools';
import { dueIntakeIds, nextWork, type WorkItem, type SubmitResult } from '../lib/work';
import { readAssertionLog } from '../lib/assertionLog';
import { intakeRunning } from '../lib/assertionAgent';
import { stage } from '../lib/stageStorage';
import { GardenerAssignments, gardenerLane, runConcurrentGardener } from './support/concurrentGardener';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = gitVault({ prefix: 'bb-gardener-profile-', files: { '.benchmark-snapshot': 'gardener-replay-v1\n', 'vault.yaml': 'auth: max\n' } });
  roots.push(root); const next = insertionSeq();
  const sources = Array.from({ length: 6 }, () => next());
  sources.forEach(s => appendSourceInsertionEvent(root, s));
  const tools = machineTools(root, 'tend');
  const call = (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.call(args);
  return { root, sources, call };
}
const done = () => ({ text: '', sessionId: 'fixture', wallMs: 1, usage: { input_tokens: 1, output_tokens: 1, turns: 1, cost_usd: null } });

test('concurrent sessions get distinct batches, share entity validation, and drain via normal tools', async () => {
  const { root, call } = fixture();
  let ready = 0, release!: () => void;
  const bothReading = new Promise<void>(resolve => { release = resolve; });
  const assigned: string[][] = [];
  const result = await runConcurrentGardener(root, testManifest(root), async () => {
    const lane = gardenerLane.getStore()!;
    const items = await call('next', { kinds: ['intake', 'staged'], limit: 3 }) as WorkItem[];
    const ids = items.map(i => i.job.kind === 'intake' ? i.job.insertion_id : ''); assigned[lane] = ids;
    if (++ready === 2) release(); await bothReading;
    // Two sessions name the same new entity. Normal validators resolve it once.
    const submitted = await call('submit', { items: ids.map(id => ({ submit: 'assertion', sources: [id], text: `[[Shared Atlas]] has evidence from ${id}.`, confidence: 'direct' })) }) as SubmitResult;
    expect(submitted.rejected).toBe(0);
    expect(await call('next', { kinds: ['intake', 'staged'], limit: 3 })).toEqual([]);
    return done();
  });
  expect(result.rounds.every(r => !r.error)).toBe(true);
  expect(assigned.map(a => a.length)).toEqual([3, 3]);
  expect(new Set(assigned.flat()).size).toBe(6);
  expect(dueIntakeIds(root)).toEqual([]);
  expect(new Set(readAssertionLog(root).flatMap(a => a.entities.map(e => e.id))).size).toBe(1);
  expect(intakeRunning(root)).toBe(false);
});

test('ownership rejects cross-lane filing and follows admitted arrivals', () => {
  const { root, sources } = fixture();
  const assignment = new GardenerAssignments(nextWork(root, { kinds: ['intake'], limit: 8 }));
  expect(() => assignment.validate('submit', { items: [{ submit: 'decline', insertion_ids: [sources[3]!.id] }] }, 0)).toThrow();
  expect(() => assignment.validate('submit', { items: [{ submit: 'assertion', sources: [sources[0]!.id, sources[3]!.id] }] }, 0)).toThrow();
  expect(() => assignment.validate('open', { ids: ['unassigned'] }, 0)).toThrow();
  assignment.admitted({ results: [{ index: 0, ok: true, staged: [{ id: 'staged', ok: true, insertion_id: 'ins_admitted' }] }], appended: 0, admitted: 1, passed: 0, rejected: 0, deduped: 0 }, 0);
  expect(assignment.owned('ins_admitted', 0)).toBe(true);
  expect(() => assignment.validate('submit', { items: [{ submit: 'decline', insertion_ids: ['ins_admitted'] }] }, 1)).toThrow();
});

test('serialized handlers never overlap and a failure does not poison the next submission', async () => {
  const { root } = fixture(), assignment = new GardenerAssignments(nextWork(root, { kinds: ['intake'], limit: 8 }));
  const calls: string[] = [];
  const results = await Promise.allSettled([
    assignment.serial(async () => { calls.push('first-start'); await Bun.sleep(10); calls.push('first-end'); throw Error('failed'); }),
    assignment.serial(async () => { calls.push('second'); }),
  ]);
  expect(calls).toEqual(['first-start', 'first-end', 'second']);
  expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled']);
});

test('a failed lane cannot release the lock while its sibling still runs; unfinished work stays due', async () => {
  const { root, sources, call } = fixture();
  const result = await runConcurrentGardener(root, testManifest(root), async () => {
    if (gardenerLane.getStore() === 0) throw Error('provider failed');
    await Bun.sleep(10);
    expect(intakeRunning(root)).toBe(true);
    const items = await call('next', { kinds: ['intake'], limit: 3 }) as WorkItem[];
    await call('submit', { items: [{ submit: 'decline', insertion_ids: items.map(i => i.job.kind === 'intake' ? i.job.insertion_id : ''), reason: 'Fixture' }] });
    return done();
  });
  expect(result.rounds[0]!.error).toContain('provider failed');
  expect(dueIntakeIds(root)).toEqual(sources.slice(0, 3).map(s => s.id));
  expect(intakeRunning(root)).toBe(false);
});

test('staged admission is owned before next can expose the new insertion to another lane', async () => {
  const { root, call } = fixture();
  fakeIntegrationActivation(root);
  stage(root, { id: 'example', source: 'fixture', at: '2026-09-20T00:00:00Z', line: 'Example', name: 'example.md', content: '---\nid: staged-example\nkind: mail\n---\n\nUseful new information about Atlas.' });
  const result = await runConcurrentGardener(root, testManifest(root), async () => {
    const lane = gardenerLane.getStore()!;
    if (lane === 0) {
      const admitted = await call('submit', { items: [{ submit: 'admit', staged_ids: ['example'] }] }) as SubmitResult;
      expect(admitted.admitted).toBe(1);
    }
    const items = await call('next', { kinds: ['intake'], limit: 8 }) as WorkItem[];
    expect(items.length).toBe(lane === 0 ? 4 : 3);
    await call('submit', { items: [{ submit: 'decline', insertion_ids: items.map(i => i.job.kind === 'intake' ? i.job.insertion_id : ''), reason: 'Fixture' }] });
    return done();
  });
  expect(result.rounds.every(r => !r.error)).toBe(true);
  expect(dueIntakeIds(root)).toEqual([]);
});

test('distinct assignments do not deduplicate equivalent claims grounded in different arrivals', async () => {
  const { root, call } = fixture();
  const result = await runConcurrentGardener(root, testManifest(root), async () => {
    const items = await call('next', { kinds: ['intake'], limit: 3 }) as WorkItem[];
    const ids = items.map(i => i.job.kind === 'intake' ? i.job.insertion_id : '');
    await call('submit', { items: [
      { submit: 'assertion', sources: [ids[0]], text: '[[Shared Atlas]] starts Monday.', confidence: 'direct' },
      { submit: 'decline', insertion_ids: ids.slice(1), reason: 'Fixture' },
    ] });
    return done();
  });
  expect(result.rounds.every(r => !r.error)).toBe(true);
  const claims = readAssertionLog(root);
  expect(claims).toHaveLength(2);
  expect(claims[0]!.text).toBe(claims[1]!.text);
  // Two valid evidence sets are not one idempotency key. Production rollout
  // needs a policy for this semantic overlap; serialization alone is insufficient.
  expect(claims[0]!.sources).not.toEqual(claims[1]!.sources);
});

test('related voice/revision arrivals are refused before splitting the cohort', () => {
  const { root } = fixture();
  const items = nextWork(root, { kinds: ['intake'], limit: 8 });
  const first = items[0]!;
  if (first.job.kind !== 'intake' || !('insertion' in first.inputs)) throw Error('Expected intake');
  first.inputs.voice = [{ insertion_id: 'ins_voice', kind: 'request', from: 'Owner', at: '', text: 'Keep related context together' }];
  expect(() => new GardenerAssignments(items)).toThrow('related voice');
});
