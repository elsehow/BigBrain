// Production HomeView smoke with fabricated API data; never contacts a vault.
// Run after building web/ui: bun test/support/activeAgents.browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const dist = path.resolve(__dirname, '../../web/ui/dist');
const at = new Date().toISOString();
const sessions = ['working', 'answered'].map((phase, i) => ({
  id: `pilot-${String(i + 1).repeat(32)}`, title: `Visible ${phase}`, phase, lifecycle: 'active',
  model: 'test', created: at, updated: at, lastActivityAt: at, seed: ['topic'], context: ['topic'],
  contextRevision: 0, draft: '', messages: [{ id: 'message', role: 'user', text: 'Test', at }],
}));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => {
      const u = new URL(r.request().url());
      if (u.origin !== 'http://127.0.0.1:53918') return r.abort();
      if (u.pathname === '/') return r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(dist, 'index.html')) });
      if (u.pathname.startsWith('/assets/')) return r.fulfill({ contentType: u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(dist, 'assets', path.basename(u.pathname))) });
      if (u.pathname === '/api/graph') return r.fulfill({ json: { hash: 'active-agents', nodes: [{ id: 'topic', title: 'Shared topic', group: 'entity', degree: 0 }], edges: [] } });
      if (u.pathname === '/api/pilot/chat') return r.fulfill({ json: { sessions } });
      if (u.pathname === '/api/pilot/work') return r.fulfill({ json: { sessions: [] } });
      if (u.pathname === '/api/source/read-state') return r.fulfill({ json: { sources: [], scope: 'stored_sources' } });
      if (u.pathname === '/api/recent') return r.fulfill({ json: { recent: [], nextOffset: null } });
      if (u.pathname === '/api/vault') return r.fulfill({ json: { queue: {}, view: { entities: 1, references: 0 }, inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } } });
      return r.fulfill({ status: 404, json: { error: 'Disabled in fixture' } });
    });
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget { close() {} };
      const proto = CanvasRenderingContext2D.prototype;
      for (const name of ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'fill']) {
        const original = proto[name];
        proto[name] = function (...args) {
          if (this.canvas.isConnected && !this.canvas.hasAttribute('aria-hidden')) {
            if (name === 'clearRect') this.canvas.triangles = [];
            if (name === 'beginPath') this.tracePath = [];
            if (name === 'moveTo' || name === 'lineTo') this.tracePath?.push(args);
            if (name === 'fill' && this.tracePath?.length === 3) this.canvas.triangles?.push(this.tracePath);
          }
          return original.apply(this, args);
        };
      }
    });
    await page.goto('http://127.0.0.1:53918');
    await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(c => c.triangles?.length === 2));
    assert.deepEqual(errors, []);
    const triangles = await page.locator('.lg-wrap > canvas:not([aria-hidden])').evaluate(c => c.triangles);
    assert.equal(triangles.length, 2, 'Working and answered active sessions both draw');
    assert.notDeepEqual(triangles[0], triangles[1], 'Sessions do not overlap');
    console.log('Production HomeView: working and answered agents both visible; no browser errors.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
