// Production AppShell, synthetic source: title wrapping, actions, and loading.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5207';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.abort());
    await page.goto(`${base}/sidebar-workbench.html?titleView=ready&graphTheme=dusk`);
    const header = page.locator('.drawer:not(.sidebar-quick) .note-header');
    await header.locator('.note-title').waitFor();
    await page.locator('.briefing-summary').waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const geometry = await header.evaluate(el => {
        const title = el.querySelector('.note-title');
        const ts = el.querySelector('.note-ts');
        const actions = el.querySelector('.note-actions');
        const box = node => node.getBoundingClientRect();
        return {
          wraps: box(title).height > parseFloat(getComputedStyle(title).lineHeight) * 1.5,
          noOverflow: title.scrollWidth <= title.clientWidth,
          metadataBelow: box(ts).top >= box(title).bottom,
          actionsBelow: box(actions).top >= box(ts).bottom,
          contained: box(actions).bottom <= box(el).bottom,
          bothActions: actions.querySelectorAll('button').length === 2,
        };
      });
      assert.ok(Object.values(geometry).every(Boolean), JSON.stringify({ width, geometry }));
    }
    assert.equal(await header.getByRole('button', { name: 'Open original ⌘O', exact: true }).count(), 1);
    assert.equal(await header.locator('.discuss-shortcut').getAttribute('aria-keyshortcuts'), 'Shift+Enter');
    assert.match(await header.locator('.discuss-shortcut kbd').textContent(), /⇧.*↵/);
    assert.equal(await page.locator('.summary-column .pchip').count(), 0, 'Open lives with header actions');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '/private/tmp/note-title-ready.png' });
    await page.keyboard.press('Shift+Enter');
    await page.waitForURL(/session\/pilot-/);
    await page.goto(`${base}/sidebar-workbench.html?titleView=ready&graphTheme=dusk`);
    await header.getByRole('button', { name: 'Discuss with Pilot', exact: true }).click();
    await page.waitForURL(/session\/pilot-/);
    await page.goto(`${base}/sidebar-workbench.html?titleView=loading&graphTheme=dusk`);
    await page.locator('.briefing-spinner').waitFor();
    assert.equal(await page.getByText('Preparing summary and connections…').count(), 0);
    assert.ok(await page.locator('.briefing-spinner').getAttribute('aria-label'));
    await page.screenshot({ path: '/private/tmp/note-title-loading.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: production shell wraps titles, groups actions, opens Pilot with Shift+Enter, and shows spinner-only loading');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
