// Production UI, fabricated responses only. No vault or provider access.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const dist = path.resolve(__dirname, '../../web/ui/dist');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = []; let graphRequests = 0;
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
    await page.route('**/*', r => {
      const u = new URL(r.request().url());
      if (u.origin !== 'http://127.0.0.1:53918') return r.abort();
      if (u.pathname === '/') return r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(dist, 'index.html')) });
      if (u.pathname.startsWith('/assets/')) return r.fulfill({ contentType: u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(dist, 'assets', path.basename(u.pathname))) });
      if (u.pathname === '/api/graph') { graphRequests++; return r.fulfill({ json: { hash: 'fixture', nodes: [], edges: [] } }); }
      if (['/api/pilot/chat', '/api/pilot/work'].includes(u.pathname)) return r.fulfill({ json: { sessions: [] } });
      if (u.pathname === '/api/source/read-state') return r.fulfill({ json: { sources: [], scope: 'stored_sources' } });
      if (u.pathname === '/api/recent') return r.fulfill({ json: { recent: [], nextOffset: null } });
      if (u.pathname === '/api/vault') return r.fulfill({ json: { queue: {}, view: {}, inbox: {}, requests: {} } });
      return r.fulfill({ status: 404, json: { error: 'Disabled in fixture' } });
    });
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.gardenerEvents = this; setTimeout(() => this.onopen?.(new Event('open')), 0); }
        close() {}
      };
    });
    await page.goto('http://127.0.0.1:53918');
    await page.getByRole('combobox').waitFor(); await page.mouse.move(50, 30);
    await page.waitForTimeout(300);
    const before = graphRequests;
    const progress = { phase: 'reviewing', waitingForModel: true, batch: 3, claims: 7, rejected: 0, batches: 2, lookups: 3,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), firstFilingMs: 2000 };
    const emit = data => page.evaluate(value => window.gardenerEvents.dispatchEvent(new MessageEvent('gardener', { data: JSON.stringify(value) })), data);
    await emit(progress);
    await page.getByRole('status').filter({ hasText: 'Reviewing 3 arrivals' }).waitFor();
    assert.match(await page.locator('.gardener').innerText(), /7 claims filed/);
    await page.waitForTimeout(200); assert.equal(graphRequests, before, 'Status never refetches the graph');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole('combobox').focus();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#topbar').evaluate(el => Number(getComputedStyle(el).opacity)), 1);
    await page.screenshot({ path: '/tmp/bb-gardener-progress-mobile.png' });
    assert.equal(await page.locator('.gardener').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await emit(null); await page.waitForFunction(() => !document.querySelector('.gardener'), null, { timeout: 5000 });
    await emit(progress); await page.locator('.gardener').waitFor();
    await page.evaluate(() => window.gardenerEvents.onerror(new Event('error')));
    await page.waitForFunction(() => !document.querySelector('.gardener'), null, { timeout: 5000 });
    assert.deepEqual(errors, []);
    console.log('Gardener progress: visible counts, no graph refetch, narrow layout, completion and disconnect cleanup pass.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
