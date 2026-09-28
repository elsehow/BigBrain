import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { nativeVault, NATIVE_YAML, insertion } from './support/vault';
import { scanSurface } from '../lib/searchCore';
import { pilotToolCall } from '../lib/pilot';
import { buildPilotItem } from '../lib/pilotTranscript';
import { nextWork, type IntakeInputs } from '../lib/work';
import { recentSourcePage, insertionFiler } from '../lib/sourceFeed';
import { filerChips, offFilers, filerAllows, hiddenFilerNodeIds } from '../web/ui/src/lib/feed';
import { userSide } from '../lib/transcriptProjection';
const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
test('search exposes its scope even on misses; an unfiltered retry can recover the original record', async () => {
  const original = insertion({ id: `ins_${'e'.repeat(24)}`, title: 'Economist dossier', body: 'Krugman discusses economic geography.', envelope: { source: 'api', kind: 'web-clip' }, received_at: '2026-09-05T12:00:00Z' });
  const root = nativeVault({ files: { 'vault.yaml': NATIVE_YAML }, insertions: [original] }); roots.push(root);
  const narrow = await pilotToolCall(root, 'search_vault', { query: 'Krugman', source: 'PILOT', type: 'reference', after: '2026-09-01' }) as any;
  expect(narrow.hits).toEqual([]);
  expect(narrow.applied_filters).toEqual({ source: 'pilot', type: 'reference', after: '2026-09-01' });
  // Scope changes remain explicit tool calls, never silent broadening of a
  // user-requested restriction. The response tells the model what it searched.
  const broad = await pilotToolCall(root, 'search_vault', { query: 'Krugman' }) as any;
  expect(broad.applied_filters).toEqual({});
  expect(broad.hits.some((h: any) => h.source === 'api')).toBe(true);
  const record = await pilotToolCall(root, 'read_note', { path: broad.hits[0].path }) as any;
  expect(record.markdown).toContain('Krugman discusses economic geography.');
});
test('stored email filter precedes candidate cap and preserves connector metadata', async () => {
  const events = Array.from({ length: 310 }, (_, i) => insertion({ id: `ins_${i.toString(16).padStart(24, '0')}`, title: 'Request', body: 'Request', received_at: '2026-09-06T12:00:00Z', envelope: { source: 'pilot', kind: 'note' } }));
  events.push(insertion({ id: `ins_${'f'.repeat(24)}`, title: 'Email with a request', body: 'This request has lower textual rank but must survive the source filter.', received_at: '2026-09-05T12:00:00Z', envelope: { source: 'email', kind: 'email', from: 'sender@example.com' } }));
  const root = nativeVault({ files: { 'vault.yaml': NATIVE_YAML }, insertions: events }); roots.push(root);
  const hits = scanSurface(root, 'request', 1, 'web', { filters: { source: 'email' }, ledger: false });
  expect(hits.ok).toBe(true); if (!hits.ok) return;
  expect(hits.hits).toHaveLength(1); expect(hits.hits[0]?.source).toBe('email');
  const recent = await pilotToolCall(root, 'recent', { source: 'EMAIL', limit: 1 }) as any;
  expect(recent).toMatchObject({ scope: 'stored_record', live_inbox: false, total: 1 });
  expect(recent.recent[0]).toMatchObject({ source: 'email', filing_status: 'pending', from: 'sender@example.com' });
  expect(recent.recent[0].status).toBeUndefined();
  const filtered = await pilotToolCall(root, 'search_vault', { query: 'request', source: 'EMAIL', n: 1 }) as any;
  expect(filtered.hits[0].source).toBe('email');
});
test('existing pilot transcripts garden only recognized user speech, at the same threshold and rank as chats', () => {
  const at = '2026-09-06T12:00:00Z';
  const full = buildPilotItem('conversation-test', [
    { speaker: 'user', text: 'I prefer a flat interface.', at },
    { speaker: 'pilot', text: 'UNSUPPORTED ADVICE\n\n[tool: search_vault]', at },
    { speaker: 'user', text: 'Keep the view selected when I stop you.', at },
    { speaker: 'pilot', text: 'INVENTED CLAIM', at },
    { speaker: 'user', text: 'I chose the simpler option.', at },
  ], new Date(at));
  const short = buildPilotItem('conversation-short', [{ speaker: 'user', text: 'Hello', at }, { speaker: 'pilot', text: 'REPLY', at }], new Date(at));
  // The body is the unchanged pilot-v0 format, so already-landed records
  // receive the same projection without rewriting any insertion events.
  const fullBody = full.content.split('---\n').slice(2).join('---\n');
  const shortBody = short.content.split('---\n').slice(2).join('---\n');
  const a = insertion({ id: `ins_${'a'.repeat(24)}`, body: fullBody, envelope: { source: 'pilot', kind: 'pilot-chat', from_kind: 'agent' }, received_at: at });
  const b = insertion({ id: `ins_${'b'.repeat(24)}`, body: shortBody, envelope: { source: 'pilot', kind: 'pilot-chat', from_kind: 'agent' }, received_at: at });
  const root = nativeVault({ files: { 'vault.yaml': NATIVE_YAML }, insertions: [a, b] }); roots.push(root);
  expect(userSide(fullBody).turns).toHaveLength(3);
  const jobs = nextWork(root, { kinds: ['intake'] });
  expect(jobs).toHaveLength(1); expect(jobs[0]?.job).toMatchObject({ class: 'agent-chat', insertion_id: a.id });
  const body = (jobs[0]!.inputs as IntakeInputs).insertion.body;
  expect(body).toContain('recognized speech'); expect(body).toContain('I chose the simpler option.');
  expect(body).not.toContain('UNSUPPORTED'); expect(body).not.toContain('INVENTED'); expect(body).not.toContain('[tool:');
  expect(recentSourcePage(root, 0, 20).recent.find(r => r.id === b.source_id)?.status).toBe('record');
  rmSync(`${root}/.state`, { recursive: true, force: true });
  expect(nextWork(root, { kinds: ['intake'] }).map(j => j.job.kind === 'intake' ? j.job.insertion_id : j.job.kind)).toEqual(jobs.map(j => j.job.kind === 'intake' ? j.job.insertion_id : j.job.kind));
});


test('Pilot and future agents inherit the same default-off chip for both feed and graph', () => {
  for (const envelope of [
    { source: 'pilot', from: 'pilot', from_kind: 'agent' },
    { source: 'agent-chat', from: 'future-agent', from_kind: 'agent' },
    { source: 'mcp', from: 'another-agent', from_kind: 'agent' },
    { source: 'future-agent', from_kind: 'agent' },
  ]) {
    const facet = insertionFiler(insertion({ envelope }));
    const row = { ...facet, source: envelope.source, type: 'source' };
    const node = { ...facet, source: envelope.source, id: 'source:fixture' };
    const chips = filerChips([row], [node]);
    expect(chips).toHaveLength(1); expect(chips[0]?.agent).toBe(true);
    expect(chips[0]?.label).not.toBe('other');
    const off = offFilers(chips, {});
    expect(filerAllows(row, off)).toBe(false);
    expect(hiddenFilerNodeIds([node], off)).toEqual(new Set(['source:fixture']));
    expect(offFilers(chips, { [chips[0]!.label]: true }).size).toBe(0);
  }
});
