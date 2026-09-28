import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { liveInboxTool } from '../lib/liveInbox';
import { mdVault } from './support/vault';
const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));
function vault(configured = true) {
  const root = mdVault({ files: { 'vault.yaml': configured ? 'integrations:\n  email:\n    enabled: false\n    inboxes:\n      - address: me@example.com\n        host: imap.example.com\n' : '{}', '.env': 'BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM=secret-password\n' } });
  roots.push(root); return root;
}
function fixture(uids = [1, 2, 3]) {
  const locks: string[] = []; const queries: any[] = []; let closes = 0; let released = 0;
  const row = (uid: number) => ({ uid, seq: uid, envelope: { subject: 'A request', from: [{ address: 'friend@example.com' }] }, flags: new Set<string>(), threadId: '123', labels: new Set<string>(), source: Buffer.from('From: friend@example.com\r\nSubject: A request\r\n\r\nPlease review the draft'), size: 100 });
  const fake = {
    capabilities: new Set(["X-GM-EXT-1"]),
    mailbox: { exists: uids.length, uidValidity: 77n }, on: () => {}, connect: async () => {}, close: () => { closes++; },
    getMailboxLock: async (path: string, options: unknown) => { expect(options).toEqual({ readOnly: true }); locks.push(path); return { release: () => { released++; } }; },
    search: async (q: any, options: unknown) => { queries.push(q); expect(options).toEqual({ uid: true }); return q.threadId ? [1, 2] : uids; },
    fetchAll: async (ids: number[], query: any, options: unknown) => { expect(ids.length).toBeGreaterThan(0); expect(options).toEqual({ uid: true }); if (query.source) expect(query.source.maxLength).toBe(128 * 1024); return ids.map(row); },
    fetchOne: async (_id: string, query: any, options: unknown) => { expect(query.source.maxLength).toBe(128 * 1024); expect(options).toEqual({ uid: true }); return row(3); },
    list: async () => [{ path: '[Gmail]/All Mail', specialUse: '\\All' }],
  };
  return { client: () => fake as unknown as ImapFlow, locks, queries, closes: () => closes, released: () => released };
}
test('live listing is bounded, paginates with UIDs and reports freshness without claiming reply obligations', async () => {
  const root = vault(); const f = fixture();
  const page = await liveInboxTool(root, 'inbox_list', { limit: 2 }, f) as any;
  expect(page.scope).toBe('live_inbox'); expect(page.truncated).toBe(true); expect(page.next_before_uid).toBe(2);
  expect(page.messages.map((m: any) => m.uid)).toEqual([3, 2]); expect(page.checked_at).toBeTruthy(); expect(page.reply_state).toContain('Unknown');
  expect(f.locks).toEqual(['INBOX']); expect(f.released()).toBe(1); expect(f.closes()).toBe(1);
  await liveInboxTool(root, 'inbox_list', { before_uid: 3 }, f); expect(f.queries[1]).toEqual({ all: true, uid: '1:2' });
  const thread = await liveInboxTool(root, 'inbox_read', { ref: page.messages[0].ref }, f) as any;
  expect(thread.thread).toHaveLength(2); expect(thread.selected.body).toContain('Please review'); expect(thread.thread_coverage).toContain('inbox, sent and archive');
  expect(f.locks.slice(-2)).toEqual(['INBOX', '[Gmail]/All Mail']);
  expect(f.queries.at(-1)).toEqual({ threadId: '123' });
});
test('an empty inbox never fetches a wildcard; stale refs and missing access are honest errors', async () => {
  const root = vault(); const empty = fixture([]);
  const page = await liveInboxTool(root, 'inbox_list', {}, empty) as any; expect(page.messages).toEqual([]); expect(page.truncated).toBe(false);
  const ref = Buffer.from(JSON.stringify({ account: 'me@example.com', uid: 3, validity: 'old' })).toString('base64url');
  await expect(liveInboxTool(root, 'inbox_read', { ref }, fixture())).rejects.toThrow('Invalid inbox');
  const stale = Buffer.from(JSON.stringify({ account: 'me@example.com', uid: 3, validity: '76' })).toString('base64url');
  await expect(liveInboxTool(root, 'inbox_read', { ref: stale }, fixture())).rejects.toThrow('identity changed');
  await expect(liveInboxTool(vault(false), 'inbox_list', {}, fixture())).rejects.toThrow('No live inbox connected');
});
