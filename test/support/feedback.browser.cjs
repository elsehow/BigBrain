// Synthetic data, production AppShell. CI supplies VIEWER_URL; local preview defaults to 5305.
const { chromium, webkit } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const base = process.env.FEEDBACK_PREVIEW_URL || process.env.VIEWER_URL || 'http://127.0.0.1:5305';
(async () => {
  const browser = process.env.FEEDBACK_BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const production = process.env.FEEDBACK_PRODUCTION !== '0';
    if (production) {
      const html = readFileSync('web/ui/dist/index.html', 'utf8');
      const entry = html.match(/src="\.\/([^"]+\.js)"/)[1];
      const csp = execFileSync('bun', ['-e', 'import { CSP } from "./lib/httpx.ts"; process.stdout.write(CSP)'], { encoding: 'utf8' });
      await page.route(`${base}/feedback-built.html`, route => route.fulfill({
        contentType: 'text/html', headers: { 'content-security-policy': csp },
        body: html.replace(`./${entry}`, '/feedback-fixture.js').replaceAll('href="./assets/', 'href="/dist/assets/'),
      }));
      await page.route(`${base}/feedback-fixture.js`, route => route.fulfill({ contentType: 'text/javascript', body: `
        import { installGraphFixture } from '/src/dev/graphFixture.ts';
        await installGraphFixture();
        await import('/dist/${entry}');
      ` }));
      await page.addInitScript(() => {
        window.cspFailures = [];
        document.addEventListener('securitypolicyviolation', event => window.cspFailures.push(event.violatedDirective));
      });
    }
    await page.goto(`${base}/${production ? 'feedback-built.html' : 'sidebar-workbench.html'}`);
    await page.locator('.v2').waitFor();
    await page.evaluate(() => {
      const fake = window.fetch;
      window.feedbackRequests = []; window.feedbackMode = 'offline';
      window.fetch = async (url, init) => {
        if (url !== '/api/feedback') return fake(url, init);
        window.feedbackRequests.push(JSON.parse(init.body));
        if (window.feedbackMode === 'offline') throw new TypeError('offline');
        if (window.feedbackMode === 'failed') return new Response(JSON.stringify({ error: 'Try again later.' }), { status: 502 });
        await new Promise(resolve => { window.finishFeedback = resolve; });
        return new Response(JSON.stringify({ ok: true }));
      };
    });
    const trigger = page.getByRole('button', { name: 'Feedback', exact: true });
    await page.waitForFunction(() => document.documentElement.dataset.sidebarToolbar === 'false');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.feedback-trigger')).opacity === '0');
    assert.equal(await trigger.evaluate(el => getComputedStyle(el).opacity), '0');
    await page.mouse.move(1090, 790);
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true });
    const field = page.getByRole('textbox', { name: 'What could we improve?' });
    await field.waitFor(); assert(await field.evaluate(el => el === document.activeElement));
    assert.match(await dialog.locator('#feedback-disclosure').textContent(), /Only your message and basic app diagnostics are sent—not your vault contents\. Read more\./);
    const privacy = dialog.getByRole('link', { name: 'Read more' });
    assert.equal(await privacy.getAttribute('href'), 'https://bigbrain.cool/privacy');
    await page.keyboard.press('Tab');
    assert(await privacy.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Shift+Tab');
    assert(await field.evaluate(el => el === document.activeElement));
    assert(await page.getByRole('button', { name: 'Send feedback', exact: true }).isDisabled());
    await field.fill('   '); assert(await page.getByRole('button', { name: 'Send feedback', exact: true }).isDisabled());
    await field.fill('Synthetic feedback / with keyboard shortcuts j k r');
    const hash = await page.evaluate(() => location.hash);
    await page.keyboard.type('/r'); assert.equal(await page.evaluate(() => location.hash), hash);
    await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    const original = await field.inputValue();
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert(await trigger.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Enter'); await dialog.waitFor(); assert.equal(await field.inputValue(), original);
    await page.evaluate(() => { window.feedbackMode = 'failed'; });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByText('Try again later.', { exact: true }).waitFor();
    assert.equal(await field.inputValue(), original);
    await page.evaluate(() => { window.feedbackMode = 'success'; });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    assert(await page.getByRole('button', { name: 'Sending…', exact: true }).isDisabled());
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.feedbackRequests.length), 3);
    await page.evaluate(() => window.finishFeedback());
    await page.getByText('Thanks — your feedback was sent.', { exact: true }).waitFor();
    const requests = await page.evaluate(() => window.feedbackRequests);
    assert.deepEqual(requests[1], requests[0]); assert.deepEqual(requests[2], requests[0]);
    assert.deepEqual(Object.keys(requests[0]).sort(), ['id', 'layout', 'message', 'panel', 'version']);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await trigger.click(); assert.equal(await field.inputValue(), '');
    // Native modal focus stays inside the form in both directions.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(i < 5 ? 'Tab' : 'Shift+Tab');
      assert(await dialog.evaluate(el => el.contains(document.activeElement)));
    }
    await page.setViewportSize({ width: 390, height: 650 });
    const bounds = await dialog.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.screenshot({ path: '/tmp/bigbrain-feedback.png' });
    if (production) assert.deepEqual(await page.evaluate(() => window.cspFailures), []);
    assert.deepEqual(errors, []);
    console.log('PASS: production AppShell feedback, chrome visibility, empty input, offline/failure, draft retention, retry identity, duplicate submit, keyboard/focus, mobile width');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
