/** First-run OAuth UX, with a fake OpenAI page and fixture-only local API. */
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    for (const provider of ['chatgpt', 'anthropic']) {
    const name = provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
    const origin = provider === 'chatgpt' ? 'https://auth.openai.com' : 'https://claude.ai';
    const context = await browser.newContext();
    const page = await context.newPage();
    let status = { connected: false, phase: 'idle' }, starts = 0, cancels = 0, onboarding = 'providers';
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route(`${origin}/**`, r => r.fulfill({ contentType: 'text/html', body: '<h1>OpenAI sign-in fixture</h1>' }));
    await page.route('**/api/**', route => route.fulfill({ status: 404, json: { error: 'Not part of onboarding fixture' } }));
    const setup = () => ({ vault: { path: '/fixture/vault', created: null }, identity: { name: 'Ada', entity_id: 'ada' },
      claude: { installed: false, account: null, plugin: null }, agent: null,
      codex: { installed: false, supported: false, connected: false, account: null, plugin: null }, chatgpt: provider === 'chatgpt' ? status : {connected:false,phase:'idle'}, anthropic: provider === 'anthropic' ? status : {connected:false,phase:'idle'}, onboarding });
    await page.route('**/api/setup', r => r.fulfill({ json: setup() }));
    await page.route('**/api/setup/progress', r => { onboarding=r.request().postDataJSON().step;return r.fulfill({json:setup()}); });
    await page.route(`**/api/setup/${provider}`, r => r.fulfill({ json: status }));
    await page.route(`**/api/setup/${provider}/login`, r => {
      starts++; status = { connected: false, phase: 'browser', url: `${origin}/oauth/authorize?state=fixture`, manualCode: true };
      return r.fulfill({ json: status });
    });
    await page.route(`**/api/setup/${provider}/callback`, r => {
      const url = r.request().postDataJSON().url;
      assert.equal(url, provider === 'chatgpt' ? 'http://localhost:1455/auth/callback?code=fixture&state=fixture' : 'http://localhost:53692/callback?code=fixture&state=fixture');
      status = {connected:false,phase:'finishing'};
      return r.fulfill({json:status});
    });
    await page.route(`**/api/setup/${provider}/cancel`, r => { cancels++; status = { connected: false, phase: 'idle' }; return r.fulfill({ json: status }); });
    await page.goto((process.env.GRAPH_PREVIEW_URL || process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5237') + '/');
    assert.equal(await page.getByText('npm install', { exact: false }).count(), 0);
    assert.equal(await page.getByText('Pi', { exact: true }).count(), 0);
    assert.equal(await page.locator('code').count(), 0);
    assert.equal(await page.getByRole('button', {name:'Next →',exact:true}).isEnabled(), false);
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: `Connect ${name}`, exact: true }).click();
    const auth = await popup;
    await auth.waitForURL(`${origin}/**`);
    assert.equal(await auth.evaluate(() => window.opener), null);
    await page.getByRole('link', { name: `Continue with ${name}` }).waitFor();
    // Reload keeps the in-flight connection and never starts a second OAuth flow.
    await page.reload();
    await page.getByRole('link', { name: `Continue with ${name}` }).waitFor();
    assert.equal(starts, 1);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: `Connect ${name}`, exact: true }).waitFor();
    assert.equal(cancels, 1);
    await page.getByRole('button', { name: `Connect ${name}`, exact: true }).click();
    status = { connected: false, phase: 'error', problem: 'Fixture sign-in failed. Try again.' };
    await page.getByRole('alert').filter({ hasText: 'Fixture sign-in failed' }).waitFor();
    await page.getByText('Setup incomplete', {exact:true}).waitFor();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('link', {name:`Continue with ${name}`}).waitFor();
    await page.getByText('Browser didn’t return?',{exact:true}).click();
    await page.getByLabel('Callback URL',{exact:true}).fill(provider === 'chatgpt' ? 'http://localhost:1455/auth/callback?code=fixture&state=fixture' : 'http://localhost:53692/callback?code=fixture&state=fixture');
    await page.getByRole('button',{name:'Finish connection',exact:true}).click();
    await page.getByRole('status').filter({ hasText: 'Finishing connection' }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: 'Set up BigBrain' }).count(), 1);
    status = { connected: true, phase: 'connected' };
    await page.getByRole('region',{name:`${name} provider`}).getByText('Connected',{exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog', { name: 'Set up BigBrain' }).count(),1);
    await page.getByRole('button',{name:'Next →',exact:true}).click();
    await page.getByRole('heading',{name:'Connect agents',exact:true}).waitFor();
    assert.deepEqual(errors, []);
    console.log(`${name} first-run browser flow passed: no CLI, browser auth, reload, cancel, retry, completion.`);
    await context.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
