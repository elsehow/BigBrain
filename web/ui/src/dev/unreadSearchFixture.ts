// Fabricated responses installed BEFORE AppShell mounts: no store seeding.
import type { SourceReadState } from '../../../../lib/sourceReadStateTypes';
const path = (i: number) => `sources/unread-fixture-${i}.md`;
const recent = Array.from({ length: 205 }, (_, i) => ({ path: path(i), title: `Unread fixture ${i}`, modified: 205 - i }));
const state = (unread: boolean | null): SourceReadState => ({ unread, status: unread === null ? 'unknown' : 'synced', writable: false });
export const unreadFixture = {
  unread: false, fail: false, posts: 0, offsets: [] as number[],
  releaseGraph: () => {}, releasePage: () => {}, holdPage: false, heldPages: 0,
};
export function installUnreadSearchFixture() {
  const original = window.fetch;
  const graphReady = new Promise<void>(resolve => { unreadFixture.releaseGraph = resolve; });
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === '/api/source/read-state') {
      if ((init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'POST') {
        unreadFixture.posts++; return Response.json({}, { status: 405 });
      }
      if (unreadFixture.fail) return Response.json({}, { status: 503 });
      return Response.json({ sources: [
        { path: path(0), readState: state(unreadFixture.unread) },
        { path: path(1), readState: state(unreadFixture.unread ? true : null) },
        { path: path(2), readState: state(null) },
        { path: 'log/insertions/unread-fixture-member.json', readState: state(true) },
        ...recent.slice(101).map(row => ({ path: row.path, readState: state(true) })),
      ] });
    }
    if (url.pathname === '/api/graph') {
      await graphReady;
      return Response.json({ nodes: [{ id: 'fixture-thread', path: path(3), title: 'Unread fixture 3', group: 'source', degree: 0,
        memberPaths: ['log/insertions/unread-fixture-member.json'] }], edges: [] });
    }
    if (url.pathname === '/api/recent') {
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 40);
      unreadFixture.offsets.push(offset);
      if (unreadFixture.holdPage && limit === 100) {
        unreadFixture.holdPage = false;
        unreadFixture.heldPages++;
        await new Promise<void>(resolve => { unreadFixture.releasePage = resolve; });
      }
      return Response.json({ recent: recent.slice(offset, offset + limit), nextOffset: offset + limit < recent.length ? offset + limit : null, total: recent.length });
    }
    return original(input, init);
  }) as typeof window.fetch;
}
