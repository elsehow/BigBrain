/** Production chat UI with simulated APIs; no live approvals or model calls. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBfcAAAAASUVORK5CYII=';
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let workUrl;
  page.on('request', r => { if (r.url().includes('/src/lib/workSessions.svelte.ts')) workUrl = r.url(); });
  const at = new Date().toISOString(), id = 'pilot-' + 'a'.repeat(32), wid = 'work-' + 'b'.repeat(32);
  const session = { id, title: 'Image discussion', model: 'test', phase: 'answered', lifecycle: 'active', seed: [], context: [], viewRevision: 0, revision: 1, draft: '', messages: [], live: '', activity: '', error: '', created: at, updated: at };
  const worker = { id: wid, title: 'Prototype', provider: 'codex', status: 'needs-input', model: 'test', cwd: '/demo', origin: { pilot: id, message: 'm' }, context: {}, created: at, updated: at, messages: [], receipts: [], pending: true,
   access: { revision: 1, grants: [], history: [], revoked: [], requests: [{ id: 'access-1', status: 'pending', path: '/demo/python', access: 'read', reason: 'Validate the prototype', revision: 1, created: at }] },
   attention: { key: 'access-1', session: wid, title: 'Prototype', kind: 'approval', text: 'Allow read access?', questions: [] } };
  const uploads = [], sends = [], decisions = [];
  await page.route('**/api/**', async route => {
   const req = route.request(), url = new URL(req.url()), path = url.pathname, b = req.postDataJSON() ?? {};
   const ok = json => route.fulfill({ json });
   if (path === '/api/setup') return route.fulfill({ status: 404, json: {} });
   if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': hello\n\n' });
   if (path === '/api/graph') return ok({ nodes: [], edges: [], hash: 'images' });
   if (path === '/api/pilot/chat/image') {
    if (req.method() === 'GET') return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
    uploads.push(b); return ok({ id: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex') + '.png', name: b.name });
   }
   if (path === '/api/pilot/chat') return ok({ sessions: [session] });
   if (path === '/api/pilot/chat/notifications') return ok({ notifications: [] });
   if (path === '/api/pilot/chat/send') { sends.push(b); session.messages.push({ id: 'message-' + sends.length, role: 'user', text: b.text, images: b.images, at }); session.draft = ''; session.revision++; return ok(session); }
   if (path === '/api/pilot/chat/draft') { session.draft = b.text; session.draftImages = b.images; session.revision++; return ok(session); }
   if (path.startsWith('/api/pilot/chat/')) return ok(session);
   if (path === '/api/pilot/work/respond') {
    assert.equal(b.id, wid); assert.equal(b.requestKey, worker.attention.key); decisions.push(b);
    worker.access.requests = []; delete worker.attention; delete worker.pending; worker.status = 'working'; return ok(worker);
   }
   if (path === '/api/pilot/work/send') { sends.push(b); worker.messages.push({ id: 'worker-message', role: 'user', text: b.text, images: b.images, at }); return ok(worker); }
   if (path === '/api/pilot/work') return ok(url.searchParams.has('id') ? worker : { sessions: [worker] });
   if (path === '/api/source/read-state') return ok({ sources: [] });
   if (path === '/api/entity/folds') return ok({ groups: [] });
   if (path.includes('recent')) return ok({ recent: [], nextOffset: null });
   return ok({ sessions: [], workers: [], notes: [], groups: [], configured: false });
  });
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5219');
  await page.mouse.move(800, 5);
  await page.getByRole('button', { name: 'Pilots, needs you', exact: true }).click();
  const pilotRow = page.locator('.pilot-row'); await pilotRow.waitFor();
  assert.equal(await pilotRow.count(), 1, 'Worker request appears under its parent Pilot');
  assert.ok((await pilotRow.textContent()).includes('Image discussion'));
  assert.equal(await page.locator('.pilots-anchor .attention-dot').count(), 2);
  await page.keyboard.press('j'); await page.keyboard.press('Enter');
  const pilot = page.getByRole('region', { name: 'Pilot conversation' }); await pilot.waitFor();
  const request = page.getByRole('region', { name: 'Request from Prototype' }); await request.waitFor();
  assert.ok((await request.textContent()).includes('/demo/python'));
  await request.getByRole('button', { name: 'Allow', exact: true }).click();
  await request.waitFor({ state: 'detached' }); assert.equal(decisions[0].answer.decision, 'accept');
  assert.equal(await page.getByRole('region', { name: 'Worker monitor' }).count(), 0);
  assert.equal(await page.locator('.pilots-trigger .attention-dot').count(), 0, 'Resolving the worker request clears the Pilot dot');
  worker.pending = true; worker.status = 'needs-input'; worker.attention = { key: 'question-2', kind: 'question', session: wid, title: worker.title, text: 'Which dataset?', questions: [{ id: 'dataset', question: 'Which dataset?', options: [{ label: 'Original' }] }] };
  await page.evaluate(async url => (await import(url)).refreshWork(), workUrl);
  await request.getByRole('button', { name: 'Original', exact: true }).click();
  await request.getByRole('button', { name: 'Send answer', exact: true }).click();
  await request.waitFor({ state: 'detached' }); assert.deepEqual(decisions[1].answer.answers.dataset.answers, ['Original']);
  const paste = async locator => locator.evaluate((el, png) => {
   const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0)); const data = new DataTransfer(); data.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
   el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  const editor = pilot.getByRole('textbox', { name: 'Message Pilot', exact: true });
  await paste(editor); await pilot.getByRole('button', { name: 'Remove image 1' }).waitFor();
  assert.equal(uploads[0].data, 'data:image/png;base64,' + png);
  await pilot.getByRole('button', { name: 'Remove image 1' }).click();
  assert.equal(await pilot.getByRole('img', { name: 'screenshot.png' }).count(), 0);
  await paste(editor); await pilot.getByRole('button', { name: 'Remove image 1' }).waitFor();
  await editor.press('Enter');
  await pilot.getByRole('button', { name: 'Remove image 1' }).waitFor({ state: 'detached' });
  assert.equal(sends[0].text, ''); assert.equal(sends[0].images.length, 1);
  await pilot.getByRole('img', { name: 'screenshot.png' }).waitFor();
  await page.reload();
  await page.getByRole('region', { name: 'Pilot conversation' }).getByRole('img', { name: 'screenshot.png' }).waitFor();
  await page.evaluate(async ({ url, wid }) => { const m = await import(url); await m.refreshWork(); m.selectWork(wid); }, { url: workUrl, wid });
  const agent = page.getByRole('region', { name: 'Worker monitor' }); await agent.waitFor();
  const workerEditor = agent.getByRole('textbox', { name: 'Message worker' });
  await paste(workerEditor); await agent.getByRole('button', { name: 'Remove image 1' }).waitFor(); await workerEditor.press('Enter');
  await agent.getByRole('button', { name: 'Remove image 1' }).waitFor({ state: 'detached' });
  assert.equal(sends.at(-1).id, wid); assert.equal(sends.at(-1).text, ''); assert.equal(sends.at(-1).images.length, 1);
  await agent.getByRole('img', { name: 'screenshot.png' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS pasted image previews/removal, image-only Pilot and worker messages, reload, and exact worker approvals/questions from Pilot');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
