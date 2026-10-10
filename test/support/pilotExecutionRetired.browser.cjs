// The production base and Field over a fabricated vault; no live vault or model.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5231';
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], executionRequests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', request => {
      if (request.url().includes('/api/agent-orchestration') || (request.method() === 'POST' && request.url().includes('/api/pilot/work/'))) executionRequests.push(request.url());
    });
    await page.goto(`${base}/sidebar-workbench.html#/settings/connected-clients`);
    await page.locator('.rail').waitFor();
    assert.equal(await page.locator('.rail').getByRole('button', { name: 'connected agents', exact: true }).count(), 1);
    assert.equal(await page.locator('.rail').getByRole('button', { name: 'connected clients', exact: true }).count(), 0);
    for (const route of ['#/settings/agent-orchestration', '#/settings/connected-agents', '#connectedAgents']) {
      await page.goto(`${base}/sidebar-workbench.html${route}`);
      await page.locator('.rail').waitFor();
      assert.equal(await page.getByRole('button', { name: 'New environment +', exact: true }).count(), 0);
      assert.equal(await page.getByText('Project environments', { exact: true }).count(), 0);
    }
    assert.deepEqual(executionRequests, []);
    assert.deepEqual(errors, []);
    console.log('PASS: execution settings removed and their old routes land safely in Settings');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
