import { expect, test } from 'bun:test';
import { sourceReadIndex, sourceUnreadKey } from '../web/ui/src/lib/sourceReadIndex';
import { scanUnreadPage } from '../web/ui/src/lib/unreadSearch';
import { createPagedSearch, emptyPagedResults } from '../web/ui/src/lib/pagedSearch';
import type { SourceReadState } from '../lib/sourceReadStateTypes';
const state = (unread: boolean | null): SourceReadState => ({ unread, status: 'unknown', writable: false });
const hit = (path: string) => ({ note: { path } });
const pause = () => Bun.sleep(20);

test('effective unread dependency covers provider changes, delayed aliases and unknown, not timestamps', () => {
  const rows = [{ path: 'member', readState: state(false) }, { path: 'unknown', readState: state(null) }];
  expect(sourceUnreadKey(sourceReadIndex([], rows))).toBe('[]');
  rows[0].readState.unread = true;
  const before = sourceUnreadKey(sourceReadIndex([], rows));
  expect(before).toBe('["member"]');
  rows[0].readState.checkedAt = 'new observation';
  expect(sourceUnreadKey(sourceReadIndex([], rows))).toBe(before);
  const nodes = [{ id: 'thread', path: 'canonical', memberPaths: ['member'], sourcePaths: ['old'] }];
  expect(sourceUnreadKey(sourceReadIndex(nodes, rows))).toBe('["canonical","member","old","thread"]');
});

test('scans past 100 excluded read/unknown rows and preserves raw pagination', async () => {
  const hits = Array.from({ length: 205 }, (_, i) => hit(String(i)));
  const index = new Map(hits.map((h, i) => [h.note.path, state(i >= 101 ? true : i % 2 ? null : false)]));
  const calls: number[] = [];
  const fetchPage = async (offset: number) => { calls.push(offset); return { hits: hits.slice(offset, offset + 100), nextOffset: offset + 100 < hits.length ? offset + 100 : null }; };
  const first = await scanUnreadPage(fetchPage, index, 0, new AbortController().signal);
  expect(calls).toEqual([0, 100]); expect(first.hits.length).toBe(99); expect(first.nextOffset).toBe(200);
  const last = await scanUnreadPage(fetchPage, index, first.nextOffset!, new AbortController().signal);
  expect(last.hits.length).toBe(5); expect(last.nextOffset).toBeNull();
});

test('changed membership rescans cached exclusions within 15s; stale completion cannot overwrite or poison cache', async () => {
  const results = emptyPagedResults<ReturnType<typeof hit>>();
  let index = new Map([['source', state(false)]]);
  let release: (() => void) | undefined;
  let hold = false, calls = 0;
  const runner = createPagedSearch(results, async (_, offset, signal) => {
    const snapshot = index;
    return scanUnreadPage(async () => {
      calls++;
      if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
      return { hits: [hit('source')], nextOffset: null };
    }, snapshot, offset, signal);
  });
  const start = () => runner.start('', sourceUnreadKey(index));
  start(); await pause(); expect(results.hits).toEqual([]);
  index = new Map([['source', state(true)]]); start(); await pause();
  expect(results.hits).toEqual([hit('source')]); expect(calls).toBe(2);
  // Use a fresh dependency to hold an old scan, then supersede it with cached
  // strict-read membership. A transport ignoring abort must still stay silent.
  index = new Map([['source', state(true)], ['alias', state(true)]]); hold = true; start(); await pause();
  index = new Map([['source', state(false)]]); start(); release!(); await pause();
  expect(results.hits).toEqual([]);
  index = new Map([['source', state(true)], ['alias', state(true)]]); start(); await pause();
  expect(calls).toBe(4); expect(results.hits).toEqual([hit('source')]); runner.cancel();
});
