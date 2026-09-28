const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await page.route('**/api/setup', r => r.fulfill({ json: {
      vault: { path: '/fixture', created: null }, identity: { name: 'Ada', entity_id: 'ada' }, agent: null,
      chatgpt: { phase: 'connected', connected: true }, anthropic: {phase:'idle',connected:false},
      claude: { installed: '2.1.247', account: 'fixture@example.com', plugin: null },
      codex: { installed: '0.155.0', supported: true, account: '', connected: false, plugin: null },
    } }));
    await page.route('**/api/tokens', r => r.fulfill({ json: { tokens: [] } }));
    await page.route('**/api/config', r => r.fulfill({ json: { integrations: [{ name: 'agent-chat', enabled: true }] } }));
    await page.goto((process.env.GRAPH_PREVIEW_URL || process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:4757') + '/#/agents');
    await page.getByText('MODELS', { exact: true }).waitFor();
    await page.getByText('1 connected', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', {name:'ChatGPT provider', exact:true}).count(), 1);
    assert.equal(await page.getByLabel('Claude connection', { exact: true }).count(), 0);
    assert.equal(await page.locator('.providers > details').count(), 0);
    await page.getByLabel('ChatGPT connection', {exact:true}).getByText('Connected', {exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Sign in again',exact:true}).count(),0);
    assert.equal(await page.getByLabel('ChatGPT connection', {exact:true}).getByRole('button').count(),0);
    await page.getByRole('button',{name:'New connection +',exact:true}).click();
    await page.getByRole('button',{name:'Claude',exact:true}).click();
    await page.getByLabel('Claude connection',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Connect Claude',exact:true}).waitFor();
    assert.equal(await page.getByText('claude', {exact:true}).count(), 0);
    assert.equal(await page.getByText('Codex', { exact: true }).isVisible(), false);
    assert.equal(await page.getByRole('switch').count(), 0);
    assert.equal(await page.getByText('Chat capture', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Set up capture tools', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('Provider connections passed: compact provider rows, accurate count, no external capture controls.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
