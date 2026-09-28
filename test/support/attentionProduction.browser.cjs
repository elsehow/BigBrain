/** Real app components, fabricated API responses; never touches mail or a model. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const at = new Date().toISOString(), id = 'pilot-' + 'a'.repeat(32);
  const nodes = Array.from({ length: 105 }, (_, i) => ({ id: `mail-${i}`, path: `log/insertions/2026-09/ins_${i.toString(16).padStart(24, '0')}.json`, title: `Message ${i + 1}`, group: 'source', degree: 1, x: Math.cos(i)*200, y: Math.sin(i)*200 }));
  let rows = nodes.map(n => ({ path: n.path, title: n.title, readState: { unread: true, writable: true, status: 'synced', provider: 'email' } }));
  let notices = [{ id: 'notice-1', key: 'dataset', pilotId: id, pilotTitle: 'Research', messageId: 'question-1', text: 'Which dataset should I use?', kind: 'question', seen: false, at }];
  const sessions = [{ id, title: 'Research', model: 'test', phase: 'answered', lifecycle: 'dormant', seed: [], context: [], viewRevision: 0, revision: 1, draft: '', messages: [{ id: 'question-1', role: 'assistant', text: notices[0].text, at }], live: '', activity: '', error: '', created: at, updated: at }];
  const writes = [], briefs = [], sends = []; let failOne = true, failRead = false, slowRead = false;
  await page.route('**/api/**', async route => {
   const req = route.request(), url = new URL(req.url()), path = url.pathname, b = req.postDataJSON() ?? {};
   const ok = json => route.fulfill({ json });
   if (path === '/api/setup') return route.fulfill({ status: 404, json: {} });
   if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': hello\n\n' });
   if (path === '/api/vault') return ok({ inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } });
   if (path === '/api/graph') return ok({ nodes, edges: [], hash: 'attention-live' });
   if (path === '/api/source/read-state') {
    if (req.method() === 'GET') {
     if (slowRead) await new Promise(resolve => setTimeout(resolve, 1000));
     if (failRead) return route.fulfill({ status: 503, json: { error: 'Provider unavailable' } });
     return ok({ sources: rows, scope: 'stored_sources' });
    }
    writes.push(b);
    const results = b.paths.map(p => { const row = rows.find(r => r.path === p); const success = !(failOne && p === nodes[0].path); if (success) row.readState.unread = b.unread; return { ...row, ok: success }; });
    return ok({ ok: results.every(r => r.ok), results });
   }
   if (path === '/api/pilot/chat') return ok({ sessions: sessions.map(s => ({ ...s, notifications: notices.filter(n => n.pilotId === s.id) })) });
   if (path === '/api/pilot/chat/notifications') return ok({ notifications: notices });
   if (path === '/api/pilot/chat/notification-state') { notices = notices.map(n => n.id === b.id ? { ...n, ...(b.action === 'seen' ? { seen: true } : { dismissed: true }) } : n); return ok({ ok: true }); }
   if (path === '/api/pilot/chat/create') { const s = { ...sessions[0], id: b.id, seed: b.context, context: b.context, messages: [], phase: 'draft', lifecycle: 'active', revision: 1 }; sessions.push(s); return ok(s); }
   if (path === '/api/pilot/chat/send') { sends.push(b); const s = sessions.find(s => s.id === b.id); s.revision++; s.messages.push({ id: 'answer', role: 'user', text: b.text, at }); if (b.notificationId) notices = notices.map(n => n.id === b.notificationId ? { ...n, resolved: true } : n); s.notifications = notices.filter(n => n.pilotId === s.id); return ok(s); }
   if (path.startsWith('/api/pilot/chat/')) { const s = sessions.find(s => s.id === b.id); if (s && path.endsWith('/draft')) { s.draft = b.text; s.revision++; } if (s) s.notifications = notices.filter(n => n.pilotId === s.id); return ok(s ?? { ok: true }); }
   if (path === '/api/note/briefing') { briefs.push(b); return ok({ briefing: { key: 'brief-' + briefs.length, model: 'test', generatedAt: at, summary: b.purpose === 'unread' ? 'A dataset decision needs your attention.' : 'Selected source summary.', links: [] } }); }
   if (path === '/api/note') return ok({ path: url.searchParams.get('path'), content: '# Sample message\nChoose a dataset.' });
   if (path === '/api/pilot') return ok({ configured: false, enabled: false });
   if (path.includes('/work/')) return ok({ sessions: [], workers: [] });
   if (path === '/api/entity/folds') return ok({ groups: [] });
   if (path.includes('recent')) return ok({ recent: [], nextOffset: null });
   return ok({ sessions: [], workers: [], notes: [], groups: [], configured: false });
  });
  const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5208';
  await page.goto(base); await page.getByRole("button", { name: "Select all 105 unread sources" }).waitFor(); await page.mouse.move(800, 5);
  // Typing u must stay in the field; bare u on the graph selects unread.
  await page.evaluate(() => { const input = document.createElement('input'); input.id = 'unread-shortcut-input'; document.body.append(input); input.focus(); });
  await page.keyboard.type('u');
  assert.equal(await page.locator('#unread-shortcut-input').inputValue(), 'u');
  assert.equal(briefs.length, 0);
  await page.evaluate(() => document.querySelector('#unread-shortcut-input').remove());
  await page.keyboard.press('u');
  await page.getByText('A dataset decision needs your attention.', { exact: true }).waitFor();
  await page.screenshot({ path: '/private/tmp/attention-production-unread.png', animations: 'disabled' });
  assert.equal(briefs.at(-1).selected.length, 105); assert.equal(briefs.at(-1).purpose, 'unread');
  await page.getByRole('button', { name: 'MARK READ', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '104 of 105 messages marked read.' }).waitFor();
  assert.deepEqual(writes.map(w => w.paths.length), [100, 5]);
  assert.equal(rows.filter(r => r.readState.unread).length, 1);
  await page.getByRole('button', { name: 'Select all 1 unread sources' }).click();
  failOne = false; await page.getByRole('button', { name: 'MARK READ', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '1 of 1 messages marked read.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Select all 0 unread sources' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: /^Pilots/ }).count(), 1);
  await page.getByRole('button', { name: 'MARK UNREAD', exact: true }).click();
  await page.getByRole('button', { name: 'Select all 1 unread sources' }).waitFor();
  await page.getByRole('button', { name: /^Pilots/ }).click();
  await page.locator('.pilot-row').waitFor();
  assert.equal(await page.locator('.pilot-row').count(), 1);
  assert.equal(await page.locator('.pilots-anchor .attention-dot').count(), 2);
  const dots = await page.locator('.pilots-anchor .attention-dot').evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
  assert.deepEqual(dots, [7, 7]);
  await page.keyboard.press('j');
  await page.getByText('Which dataset should I use?', { exact: true }).waitFor();
  await page.keyboard.press('ArrowUp');
  await page.screenshot({ path: '/private/tmp/attention-production-pilots.png', animations: 'disabled' });
  assert.equal(notices[0].seen, false, 'Browsing does not mark a request seen or resolved');
  await page.keyboard.press('Enter');
  await page.locator('.notification-target').waitFor();
  await page.getByRole('textbox', { name: 'Message Pilot', exact: true }).fill('Use the original dataset.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.reply-target'));
  assert.equal(sends.at(-1).notificationId, 'notice-1');
  await page.reload(); await page.mouse.move(800, 5);
  await page.getByRole('button', { name: /^Pilots/ }).click();
  await page.getByText('No active Pilots.', { exact: true }).waitFor();
  assert.equal(await page.locator('.pilots-anchor .attention-dot').count(), 0);
  notices[0].resolved = false;
  sessions[0].deactivatedAt = at; sessions[0].revision++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.pilots-anchor .attention-dot').count(), 0, 'Explicitly closed Pilot stays idle despite an unanswered historical question');
  const beforeEscape = page.url();
  await page.keyboard.press('Escape');
  await page.locator('.pilots-pane').waitFor({ state: 'hidden' });
  assert.equal(page.url(), beforeEscape, 'Escape closes Pilots without navigating');
  assert.equal(await page.getByRole('button', { name: /^Pilots/ }).evaluate(el => el === document.activeElement), true);
  notices.push({ ...notices[0], id: 'update-1', kind: 'update', resolved: false, seen: false, text: 'An informational update.' });
  sessions[0].revision++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.keyboard.press('a');
  await page.getByText('No active Pilots.', { exact: true }).waitFor();
  assert.equal(await page.locator('.pilots-anchor .attention-dot').count(), 0, 'Updates do not request attention');
  assert.equal(await page.locator('.notification-toast').count(), 0);
  await page.keyboard.press('Escape');
  rows = rows.map(r => ({ ...r, readState: { ...r.readState, unread: true } }));
  await page.reload(); await page.mouse.move(800, 5);
  await page.getByRole('button', { name: 'Select all 105 unread sources' }).click();
  await page.keyboard.press('Shift+Enter');
  await page.getByRole('region', { name: 'Pilot text tab' }).waitFor();
  assert.equal(sessions.at(-1).seed.length, 105);
  for (const width of [390, 320]) {
   await page.setViewportSize({ width, height: 900 }); await page.mouse.move(150, 20);
   await page.getByRole('button', { name: /^Pilots/ }).click();
   const box = await page.locator('.pilots-pane').boundingBox();
   assert.ok(box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
   await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  rows = rows.map(r => ({ ...r, readState: { ...r.readState, unread: null, writable: false, status: 'unavailable' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const retry = page.getByRole('button', { name: 'Retry unread source check', exact: true });
  await retry.waitFor(); assert.equal(await retry.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Select all 0 unread sources' }).count(), 0);
  failRead = true;
  await retry.click(); await retry.waitFor();
  failRead = false; slowRead = true;
  rows = rows.map(r => ({ ...r, readState: { ...r.readState, unread: true, writable: true, status: 'synced' } }));
  await retry.click();
  await page.getByRole('button', { name: 'Checking unread sources', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Select all 105 unread sources' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Production attention UI: selection, chunked writes, Pilot requests, keyboard navigation, mobile layout, unavailable read states and retry recovery passed.');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
