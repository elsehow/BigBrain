/** production base and Field with fabricated providers; no vault or model calls. */
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function fixture() {
      await page.locator('.v2').waitFor();
      await page.evaluate(() => {
        const original = window.fetch.bind(window);
        const saved = JSON.parse(localStorage.getItem('fixture-model-choices') || 'null');
        const config = saved?.config ?? { integrations: [], gardener: { adapter: 'pi', provider: 'anthropic', model: 'opus' }, memory: { adapter: 'pi', provider: 'anthropic', model: 'fable' }, quick: { adapter: 'pi', provider: 'anthropic', model: 'haiku' } };
        let backend = saved?.backend ?? { adapter: 'pi', provider: 'openai-codex', model: 'shared-fixture', reasoning: 'low' };
        const preferences = saved?.preferences ?? { gardener: 'pinned', memory: 'pinned', quick: 'pinned', pilot: 'pinned' };
        const recommendations = { gardener: { adapter: 'pi', provider: 'anthropic', model: 'opus' }, memory: { adapter: 'pi', provider: 'anthropic', model: 'opus' }, quick: { adapter: 'pi', provider: 'anthropic', model: 'haiku' }, pilot: { adapter: 'pi', provider: 'anthropic', model: 'opus' } };
        const agents = [
          { id: 'pi/anthropic', label: 'Claude', ready: true, models: ['opus', 'fable', 'haiku'].map(id => ({ id, label: id, reasoning: ['low', 'high'] })) },
          { id: 'pi/openai-codex', label: 'ChatGPT', ready: true, billing: 'subscription', models: [{ id: 'shared-fixture', label: 'Shared fixture', reasoning: ['low', 'high'] }] },
          { id: 'pi/openai', label: 'OpenAI via Pi', ready: true, billing: 'api', models: [{ id: 'shared-fixture', label: 'Shared fixture', reasoning: ['low', 'high'] }, { id: 'other-fixture', label: 'Other fixture', reasoning: ['low'] }] },
        ];
        window.modelFixture = { config, writes: [], fail: false, failLoad: false };
        const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (input, options) => {
          const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
          if (path === '/api/agents/models' || path === '/api/pilot/chat/models') return json({ agents, preferences, recommendations });
          if (path === '/api/models/preference') {
            const { role, preference } = JSON.parse(options.body);
            if (window.modelFixture.fail) return json({ error: 'Fixture preference refused' }, 400);
            preferences[role] = preference;
            if (preference === 'recommended') {
              if (role === 'pilot') backend = recommendations[role]; else config[role] = recommendations[role];
            }
            localStorage.setItem('fixture-model-choices', JSON.stringify({ config, backend, preferences }));
            return json({ preferences });
          }
          if (path === '/api/config') {
            if (window.modelFixture.failLoad) return json({ error: 'Fixture load failed' }, 500);
            if (options?.method === 'POST') {
              const patch = JSON.parse(options.body); window.modelFixture.writes.push(patch);
              if (window.modelFixture.fail) return json({ error: 'Fixture save refused' }, 400);
              Object.assign(config, patch);
              for (const role of Object.keys(patch)) preferences[role] = 'pinned';
              localStorage.setItem('fixture-model-choices', JSON.stringify({ config, backend, preferences }));
              return json({ changed: ['vault.yaml'], committed: true });
            }
            return json(config);
          }
          if (path === '/api/pilot/chat/backend') {
            if (options?.method === 'POST') {
              backend = JSON.parse(options.body).backend; preferences.pilot = 'pinned';
              localStorage.setItem('fixture-model-choices', JSON.stringify({ config, backend, preferences }));
            }
            return json(backend);
          }
          return original(input, options);
        };
      });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
      await page.getByRole('button', { name: 'models', exact: true }).click();
      await page.getByLabel('Gardener model', { exact: true }).waitFor();
    }
    const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5279';
    await page.goto(`${base}/sidebar-workbench.html`);
    await fixture();
    const model = role => page.getByLabel(`${role} model`, { exact: true });
    const ready = role => page.waitForFunction(role => !document.querySelector(`[aria-label="${role} model"]`).disabled, role);
    for (const role of ['Gardener', 'Memory', 'Pilot']) {
      assert.equal(await model(role).locator('option[value="pi/openai:shared-fixture"]').count(), 1);
      await model(role).selectOption('pi/openai:shared-fixture'); await ready(role);
      await page.getByLabel(`${role} reasoning`, { exact: true }).selectOption('high'); await ready(role);
    }
    assert.equal(await model('Quick').locator('option[value="pi/openai:shared-fixture"]').count(), 0);
    assert.equal(await model('Quick').locator('option[value="pi/openai-codex:shared-fixture"]').count(), 1);
    await page.getByText(/Quick requires an enforceable API spending limit/).waitFor();
    assert.equal(await page.getByText(/Runs automatically and bills API usage/).count(), 2);
    const choices = await page.evaluate(() => window.modelFixture.config);
    for (const role of ['gardener', 'memory']) assert.deepEqual(choices[role], { adapter: 'pi', provider: 'openai', model: 'shared-fixture', reasoning: 'high' });
    await page.evaluate(() => { window.modelFixture.fail = true; });
    await model('Gardener').selectOption('pi/openai-codex:shared-fixture');
    await page.getByRole('alert').filter({ hasText: 'Fixture save refused' }).waitFor();
    assert.equal(await model('Gardener').inputValue(), 'pi/openai:shared-fixture');
    await page.evaluate(() => { window.modelFixture.fail = false; });
    await model('Memory').selectOption('pi/openai:other-fixture'); await ready('Memory');
    assert.equal(await page.getByLabel('Memory reasoning', { exact: true }).inputValue(), '');
    await page.goto(`${base}/sidebar-workbench.html`); await fixture();
    assert.equal(await model('Gardener').inputValue(), 'pi/openai:shared-fixture');
    assert.equal(await page.getByLabel('Gardener reasoning', { exact: true }).inputValue(), 'high');
    assert.equal(await model('Memory').inputValue(), 'pi/openai:other-fixture');
    assert.equal(await model('Pilot').inputValue(), 'pi/openai:shared-fixture');
    const policy = role => page.getByLabel(`${role} selection policy`, { exact: true });
    for (const role of ['Gardener', 'Memory', 'Quick', 'Pilot']) {
      assert.equal(await policy(role).inputValue(), 'pinned');
      await policy(role).selectOption('recommended');
      await page.waitForFunction(role => document.querySelector(`[aria-label="${role} selection policy"]`)?.value === 'recommended', role);
    }
    assert.equal(await model('Gardener').inputValue(), 'pi/anthropic:opus');
    assert.equal(await model('Pilot').inputValue(), 'pi/anthropic:opus');
    await page.goto(`${base}/sidebar-workbench.html`); await fixture();
    assert.equal(await policy('Gardener').inputValue(), 'recommended');
    await model('Gardener').selectOption('pi/anthropic:fable'); await ready('Gardener');
    assert.equal(await policy('Gardener').inputValue(), 'pinned', 'explicit subscription selection pins too');
    await page.evaluate(() => { window.modelFixture.fail = true; });
    await policy('Gardener').selectOption('recommended');
    await page.getByRole('alert').filter({ hasText: 'Fixture preference refused' }).waitFor();
    assert.equal(await policy('Gardener').inputValue(), 'pinned');
    assert.equal(await model('Gardener').inputValue(), 'pi/anthropic:fable');
    await page.evaluate(() => { window.modelFixture.fail = false; });
    await page.setViewportSize({ width: 480, height: 1100 });
    const size = await page.locator('.settings').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert(size.scroll <= size.width, 'settings fit a narrow viewport');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '/tmp/bigbrain-model-policy.png', fullPage: true });
    console.log('PASS: production base and Field preserves API identity for all supported roles; Quick budget restriction, billing note, rollback, reasoning reset, persisted selection policies and reload');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
