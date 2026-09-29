// Production entry and sidebar shell with synthetic data; never contacts a vault/model.
// DOM/interaction coverage does not assert native macOS prediction UI or spelling marks.
const { chromium, webkit } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5217';
const expectPoll = async (check, ms = 10_000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 50)); } };
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
      // Graph-backed rows (connected or mentioned) can load after the menu opens: wait, then shift them under the highlight.
      const shift = entry !== '/';
      const firstRow = () => menu.getByRole('option').first().locator('.title').evaluate(el => ({ title: el.firstChild.textContent, hint: el.querySelector('small')?.textContent ?? '' }));
      if (shift) await expectPoll(async () => /^(Connected to|Mentioned in) /.test((await firstRow()).hint));
      await input.press('ArrowDown');
      const chosen = await menu.getByRole('option', { selected: true }).locator('.title').evaluate(el => el.firstChild.textContent);
      if (shift) {
        // Rows that change after the highlight (late recents, graph updates) must not change what Tab
        // inserts: remove leading graph rows until the highlighted item's position actually moves.
        await page.evaluate(async () => { window.savedGraph = (await import('/src/lib/pilotChat.svelte.ts')).chat.graph; });
        const position = () => menu.getByRole('option').evaluateAll((options, title) => options.findIndex(o => o.querySelector('.title').firstChild.textContent === title), chosen);
        const before = await position();
        for (let i = 0; i < 8 && (await position()) === before; i++) {
          const first = (await firstRow()).title;
          await page.evaluate(async title => {
            const { chat } = await import('/src/lib/pilotChat.svelte.ts');
            const gone = new Set(chat.graph.nodes.filter(n => n.title === title).map(n => n.id));
            chat.graph = { ...chat.graph, nodes: chat.graph.nodes.filter(n => !gone.has(n.id)), edges: chat.graph.edges.filter(e => !gone.has(e.source?.id ?? e.source) && !gone.has(e.target?.id ?? e.target)) };
          }, first);
          await expectPoll(async () => (await firstRow()).title !== first);
        }
        assert.notEqual(await position(), before, 'the rows moved under the highlight');
        assert.equal(await menu.getByRole('option', { selected: true }).locator('.title').evaluate(el => el.firstChild.textContent), chosen, 'the highlight follows its item');
      }
      await input.press('Tab');
      assert.equal(await input.locator('[data-mention]').textContent(), chosen);
      if (shift) await page.evaluate(async () => { (await import('/src/lib/pilotChat.svelte.ts')).chat.graph = window.savedGraph; });
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
