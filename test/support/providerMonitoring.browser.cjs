const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await page.route('**/api/setup', r => r.fulfill({ json: {
      vault: { path: '/fixture', created: null }, identity: { name: 'Ada', entity_id: 'ada' }, agent: null,
      chatgpt: { phase: 'connected', connected: true },
      anthropic: { phase: 'connected', connected: true },
      claude: { installed: '2.1.247', account: 'fixture@example.com', connected: true, plugin: null },
      codex: { installed: false, supported: false, account: null, connected: false, plugin: null },
    } }));
    await page.route('**/api/tokens', r => r.fulfill({ json: { tokens: [] } }));
    await page.route('**/api/config', r => r.fulfill({ json: { integrations: [] } }));
    const monitor = provider => ({ provider, since: '2026-09-17T00:00:00Z', asOf: '2026-09-24T12:00:00Z',
      capabilities: { tokens: true, quota: true }, accountIdentity: provider === 'anthropic' ? 'known' : 'unknown',
      roles: ['gardener', 'memory', 'pilot', 'quick'].map((role, i) => ({ role, runs: 2, measuredRuns: 2, tokens: (i + 1) * 100, partial: role === 'quick' })),
      quota: { state: provider === 'anthropic' ? 'stale' : 'unavailable', windows: provider === 'anthropic' ? [{ window: 'five_hour', used: .1, stale: true, resetsAt: '2026-09-24T17:00:00Z', asOf: '2026-09-24T12:00:00Z' }, { window: 'seven_day', used: .3, stale: false, resetsAt: '2026-09-27T00:00:00Z', asOf: '2026-09-24T12:00:00Z' }] : [] } });
    const providers = { anthropic: monitor('anthropic'), 'openai-codex': monitor('openai-codex') };
    await page.route('**/api/usage', r => r.fulfill({ json: { providers } }));
    await page.goto((process.env.GRAPH_PREVIEW_URL || process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5279') + '/sidebar-workbench.html?vault=live#/agents');
    await page.getByText('2 connected', { exact: true }).waitFor();
    for (const name of ['ChatGPT', 'Claude']) {
      assert.equal(await page.locator('.providers > details').count(), 0);
      const panel = page.getByRole('region', { name: `${name} usage`, exact: true });
      await panel.getByText('Gardener', { exact: true }).waitFor();
      for (const role of ['Memory', 'Pilot', 'Quick']) assert.equal(await panel.getByText(role, { exact: true }).count(), 1);
      assert.equal(await panel.getByText('400 tokens · 2 runs · partial', { exact: true }).count(), 1);
    }
    await page.getByRole('img', { name: '30% account usage, seven day', exact: true }).waitFor();
    await page.getByRole('img', { name: '10% account usage, five hour', exact: true }).waitFor();
    assert.equal(await page.getByText(/Estimated BigBrain share/).count(), 0);
    await page.getByText('Provider-reported usage for the recorded account, including activity outside BigBrain.', { exact: true }).waitFor();
    await page.getByRole('region', { name: 'ChatGPT usage', exact: true }).getByText('Quota readings use your connected subscription when the provider makes them available.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Claude usage', exact: true }).locator('.track.stale').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Sign in again', exact: true }).count(), 0);
    await page.getByRole('region', { name: 'Claude usage', exact: true }).screenshot({ path: join(tmpdir(), 'bigbrain-provider-monitoring.png') });
    await page.setViewportSize({ width: 480, height: 900 });
    const overflow = await page.getByRole('region', { name: 'ChatGPT usage', exact: true }).evaluate(el => el.scrollWidth > el.clientWidth);
    assert.equal(overflow, false);
    const chatgpt = page.getByRole('region', { name: 'ChatGPT usage', exact: true });
    providers['openai-codex'].accountIdentity = 'known';
    providers['openai-codex'].quota = { state: 'current', windows: [{ window: 'five_hour', used: .42, stale: false, resetsAt: '2026-09-27T00:00:00Z', asOf: '2026-09-24T12:00:00Z' }] };
    await page.reload();
    await chatgpt.getByRole('img', { name: '42% account usage, five hour', exact: true }).waitFor();
    assert.equal(await chatgpt.locator('.track.stale').count(), 0);
    providers['openai-codex'].accountIdentity = 'multiple';
    providers['openai-codex'].quota = { state: 'unavailable', windows: [] };
    await page.reload();
    await chatgpt.getByText('Usage spans multiple accounts; account quota is not combined.', { exact: true }).waitFor();
    assert.equal(await chatgpt.getByRole('img', { name: /account usage/ }).count(), 0);
    providers['openai-codex'].roles = [];
    providers['openai-codex'].quota = { state: 'unsupported', windows: [] };
    providers.anthropic.quota = { state: 'unavailable', windows: [] };
    await page.reload();
    assert.equal(await page.locator('.providers > details').count(), 0);
    await page.getByText('No runs recorded yet. Usage appears as BigBrain works.', { exact: true }).waitFor();
    await page.getByText('No account quota reading available yet.', { exact: true }).waitFor();
    await chatgpt.getByText('Account quota is not available from this connection.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Provider monitoring passed in AppShell: both providers, four roles, partial counts, separate account quota, per-window freshness, same-account ChatGPT quota, mismatched accounts, unavailable/unsupported/empty states, narrow layout.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
