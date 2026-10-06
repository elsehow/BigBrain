// Settings → security: the firewall switch follows the Jev key. With no key it
// is off, and trying it shows the app's own tooltip and saves nothing; with
// one it is on, and turning it off saves the owner's choice. Every /api route
// is fabricated here, so no engine is reached.
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
    let security = { remote_content: true, firewall: false, jev_key: false };
    const saved = [];
    await page.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await page.route('**/api/config', r => {
      if (r.request().method() === 'POST') {
        const patch = JSON.parse(r.request().postData() || '{}');
        saved.push(patch);
        security = { ...security, ...patch.security };
        return r.fulfill({ json: { changed: ['vault.yaml'], committed: true } });
      }
      return r.fulfill({ json: { integrations: [], security } });
    });
    const base = (process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5279') + '/sidebar-workbench.html?vault=live#/security';
    const toggle = () => page.getByRole('switch', { name: 'Firewall', exact: true });

    // no Jev key: off, and trying it says why — in the app's tooltip, not the OS's
    await page.goto(base);
    await toggle().waitFor();
    assert.equal(await toggle().getAttribute('aria-checked'), 'false');
    assert.equal(await toggle().getAttribute('title'), null, 'no native title');
    await page.mouse.move(0, 0);
    // aria-disabled, so Playwright would refuse it; a person's click still lands
    await toggle().click({ force: true });
    const tip = page.locator('.tippy-box[data-theme~="stier"]', { hasText: 'Add a Jev key to use the firewall.' });
    await tip.waitFor();
    assert.equal((await tip.innerText()).trim(), 'Add a Jev key to use the firewall.');
    const look = await tip.evaluate(el => {
      const s = getComputedStyle(el);
      const probe = document.createElement('div');
      probe.style.color = 'var(--text-strong)';
      document.body.append(probe);
      const strong = getComputedStyle(probe).color;
      probe.remove();
      return { bg: s.backgroundColor, strong };
    });
    assert.equal(look.bg, look.strong, 'the tooltip wears the theme');
    assert.equal(await toggle().getAttribute('aria-checked'), 'false', 'still off');
    assert.deepEqual(saved, [], 'nothing saved without a key');
    await page.locator('aside.panel, body').first().screenshot({ path: join(tmpdir(), 'bigbrain-firewall-no-key.png') });
    // keyboard: the same attempt, the same tooltip
    await page.mouse.move(0, 0);
    await toggle().focus();
    await page.keyboard.press('Space');
    await tip.waitFor();
    assert.deepEqual(saved, []);

    // a Jev key: on by default; off is saved, and then on again
    security = { remote_content: true, firewall: true, jev_key: true };
    await page.goto(base);
    await page.reload();
    await toggle().waitFor();
    await page.waitForFunction(() => document.querySelector('[role=switch][aria-label=Firewall]')?.getAttribute('aria-checked') === 'true');
    await page.mouse.move(0, 0);
    await toggle().hover();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.tippy-box', { hasText: 'Add a Jev key' }).count(), 0, 'no tooltip with a key');
    await toggle().click();
    await page.waitForFunction(() => document.querySelector('[role=switch][aria-label=Firewall]')?.getAttribute('aria-checked') === 'false');
    assert.deepEqual(saved, [{ security: { firewall: false } }]);
    await toggle().click();
    await page.waitForFunction(() => document.querySelector('[role=switch][aria-label=Firewall]')?.getAttribute('aria-checked') === 'true');
    assert.deepEqual(saved, [{ security: { firewall: false } }, { security: { firewall: true } }]);

    // no new words on the page beyond the switch's own name
    const words = await page.getByRole('region', { name: 'Firewall', exact: true }).innerText();
    assert.equal(words.trim(), 'Firewall');

    await page.setViewportSize({ width: 480, height: 900 });
    const narrow = await page.locator('.settings').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert(narrow.scroll <= narrow.width, 'narrow settings do not overflow');
    assert.deepEqual(errors, []);
    console.log('PASS: no Jev key — firewall off, trying it shows the themed tooltip and saves nothing; a key — on by default, off and on are saved.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
