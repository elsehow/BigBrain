/** Worker reports are synthesized by Pilot; only the Pilot answer enters chat. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; let chatUrl;
    const at = new Date().toISOString(), id = 'pilot-' + 'e'.repeat(32), workerId = 'work-' + 'f'.repeat(32);
    const key = workerId + ':turn:completed';
    const session = { id, title: 'Worker report', model: 'fixture', phase: 'working', lifecycle: 'active',
      seed: [], context: [], viewRevision: 0, revision: 1, draft: '', inputs: [], live: '', activity: '', error: '', created: at, updated: at,
      messages: [{ id: 'request', role: 'user', text: 'Summarize the research', at }],
      workEvents: [{ key, work: workerId, title: 'Research agent', kind: 'completed', text: 'RAW WORKER REPORT **do not paste into chat**', at }] };
    const worker = { id: workerId, provider: 'codex', model: 'fixture', title: 'Research agent', status: 'idle', origin: { pilot: id, message: 'request' },
      context: {}, created: at, updated: at, messages: [], receipts: [], vault: '/fixture', cwd: '/fixture' };
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
    await page.route('**/api/pilot{,/**}', route => {
      const path = new URL(route.request().url()).pathname;
      const json = path === '/api/pilot' ? { configured: false, enabled: false, status: 'disabled' }
        : path === '/api/pilot/work' ? { sessions: [worker] }
        : path === '/api/pilot/chat' ? { sessions: [session] }
        : path.endsWith('/presence') ? { ok: true } : session;
      return route.fulfill({ json });
    });
    await page.route('**/api/graph', r => r.fulfill({ json: { nodes: [], edges: [], hash: 'report-fixture' } }));
    await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198');
    await page.locator('.lg-wrap > canvas:not([aria-hidden])').waitFor();
    const refresh = () => page.evaluate(async ({ url, id }) => { const m = await import(url); await m.refreshChats(); m.openChat(id); }, { url: chatUrl, id });
    await refresh();
    await page.getByLabel('Message Pilot').waitFor();
    await page.locator('.worker-receipt').filter({ hasText: 'Research agent · idle' }).waitFor();
    assert.equal(await page.locator('.transcript').getByText('RAW WORKER REPORT', { exact: false }).count(), 0);
    session.messages.push({ id: 'summary', role: 'assistant', text: '**Research complete.** The source links are preserved.', workEventKeys: [key], at });
    session.phase = 'answered'; session.revision++;
    await refresh();
    await page.locator('.transcript strong').filter({ hasText: 'Research complete.' }).waitFor();
    assert.equal(await page.locator('.transcript').getByText('RAW WORKER REPORT', { exact: false }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS Pilot worker handoff: idle link, no raw report, rendered Pilot synthesis');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
