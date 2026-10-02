// The production AppShell, fabricated history, and no live vault or model.
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
    assert.equal(await page.locator('.rail').getByRole('button', { name: 'connected agents', exact: true }).count(), 0);
    assert.equal(await page.locator('.rail').getByRole('button', { name: 'connected clients', exact: true }).count(), 1);
    for (const route of ['#/settings/agent-orchestration', '#/settings/connected-agents', '#connectedAgents']) {
      await page.goto(`${base}/sidebar-workbench.html${route}`);
      await page.locator('.rail').waitFor();
      assert.equal(await page.getByRole('button', { name: 'New environment +', exact: true }).count(), 0);
      assert.equal(await page.getByText('Project environments', { exact: true }).count(), 0);
    }
    const id = 'work-' + 'a'.repeat(32);
    await page.goto(`${base}/sidebar-workbench.html?archived-worker=1#/session/${id}`);
    const history = page.getByRole('region', { name: 'Historical conversation' });
    await history.getByText('The project notes are saved for review.', { exact: true }).waitFor();
    await history.getByText('This conversation is archived. Agent execution is no longer available in BigBrain.', { exact: true }).waitFor();
    await history.getByText('Operations (1)', { exact: true }).click();
    await history.getByText('write: uncertain', { exact: true }).waitFor();
    for (const label of ['Interrupt', 'Send follow-up', 'Allow and launch', 'Decline']) assert.equal(await history.getByRole('button', { name: label, exact: true }).count(), 0);
    assert.equal(await history.getByRole('textbox').count(), 0);
    await page.screenshot({ path: '/tmp/bb-retired-execution-history.png' });
    await history.getByRole('button', { name: 'Back to Pilot', exact: true }).click();
    await page.locator('.pilot-panel [contenteditable=true]').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Project environment approval' }).count(), 0);
    assert.equal(await page.getByRole('status', { name: 'Connected agent activity' }).count(), 0);
    await page.locator('.pilot-panel [contenteditable=true]').fill('Summarize the project notes');
    await page.keyboard.press('Enter');
    await page.getByText('This is the sample vault. Your message stayed in this browser; no agent was contacted.', { exact: true }).waitFor();
    assert.deepEqual(executionRequests, []);
    assert.deepEqual(errors, []);
    console.log('PASS production shell: execution settings removed, old routes safe, worker history read-only, Pilot conversation available');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
