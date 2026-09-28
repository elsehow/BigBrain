// Production entry and sidebar shell with synthetic data; never contacts a vault/model.
// DOM/interaction coverage does not assert native macOS prediction UI or spelling marks.
const { chromium, webkit } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5217';
(async () => {
  const browser = process.env.PLAYWRIGHT_BROWSER === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    for (const entry of ['/', '/sidebar-workbench.html']) {
      const page = await browser.newPage();
      const errors = [], escapedApi = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', route => {
        escapedApi.push(route.request().url());
        return route.abort();
      });
      if (entry === '/') await page.route(base + '/', route => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><html><body><div id="app"></div><script type="module">
          import { installGraphFixture } from '/src/dev/graphFixture.ts';
          await installGraphFixture();
          await import('/src/main.ts');
        </script></body></html>`,
      }));
      await page.goto(base + entry);
      await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
      await page.evaluate(async () => {
        const { refreshChats, openChat } = await import('/src/lib/pilotChat.svelte.ts');
        await refreshChats(); openChat('pilot-11111111111111111111111111111111');
        const fetch = window.fetch;
        window.composerRequests = [];
        window.fetch = (input, options) => {
          window.composerRequests.push(String(input));
          return fetch(input, options);
        };
      });
      const input = page.getByRole('textbox', { name: 'Message Pilot' });
      await input.fill('then what is this autocomplete');
      await input.press('ArrowLeft');
      await input.press('ArrowLeft');
      const caret = await page.evaluate(() => getSelection().anchorOffset);
      await page.waitForTimeout(600);
      assert.equal(await input.innerText(), 'then what is this autocomplete');
      assert.equal(await page.evaluate(() => getSelection().anchorOffset), caret);
      assert.equal(await page.getByRole('listbox').count(), 0, 'ordinary text does not open @ completion');
      assert.equal(await page.evaluate(() => window.composerRequests.some(url => url.includes('/api/search'))), false);
      assert.equal(await input.evaluate(el => getComputedStyle(el, '::before').content), 'none', 'placeholder is absent while typing');

      await input.fill('@');
      const menu = page.getByRole('listbox');
      await menu.getByRole('option').first().waitFor();
      assert.match(await page.locator('.mention-menu').innerText(), /Connected to Atlas planning/);
      await input.press('ArrowDown');
      const chosen = await menu.getByRole('option', { selected: true }).locator('.title').evaluate(el => el.firstChild.textContent);
      await input.press('Tab');
      assert.equal(await input.locator('[data-mention]').textContent(), chosen);
      await input.fill('@Shared design');
      await menu.getByRole('option').filter({ hasText: 'Shared design review' }).waitFor();
      await input.press('Enter');
      assert.equal(await input.locator('[data-mention]').textContent(), 'Shared design review');
      await input.press('Shift+Enter');
      await page.keyboard.type('Keep this reference.');
      await input.press('Enter');
      await page.waitForFunction(() => !document.querySelector('[aria-label="Message Pilot"]').textContent);
      await page.locator('.sent-mention').filter({ hasText: 'Shared design review' }).waitFor();
      await input.fill('@');
      await menu.waitFor();
      await input.press('Escape');
      await menu.waitFor({ state: 'detached' });
      await page.waitForTimeout(150);
      assert.equal(await menu.count(), 0, 'a later selectionchange does not reopen an escaped menu');
      assert.equal(await input.count(), 1, 'Escape dismisses mentions without closing chat');
      await page.keyboard.type('S');
      await menu.waitFor();
      assert.equal(await input.innerText(), '@S', 'typing after Escape brings the menu back for the new text');
      await input.press('Escape');
      await menu.waitFor({ state: 'detached' });

      assert.equal(await input.evaluate(el => el.spellcheck), true, 'spellcheck remains enabled');
      assert.equal(await input.getAttribute('aria-autocomplete'), 'list', '@ picker accessibility is preserved');
      assert.deepEqual(errors, []);
      assert.deepEqual(escapedApi, [], 'all API calls stayed in the synthetic fixture');
      console.log(`PASS ${entry}: ordinary typing/caret, Connected suggestions, @ search, Tab/Enter, multiline send and Escape`);
      assert.equal(await input.getAttribute('writingsuggestions'), 'false', 'composer opts out of browser inline predictions');
      assert.equal(await input.evaluate(el => el.writingSuggestions), 'false', 'browser recognizes the field-level opt-out');
      await page.close();
    }
    console.log('PASS: composer writing suggestions disabled; spellcheck and mentions preserved');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
