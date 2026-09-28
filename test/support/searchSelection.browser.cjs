/** Floating search over an unchanged selection, using fabricated responses only. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Vancouver' });
    await page.route('**/api/**', route => route.abort());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
    await page.addInitScript(() => {
      const proto = CanvasRenderingContext2D.prototype;
      for (const name of ['clearRect', 'beginPath', 'arc', 'moveTo', 'lineTo', 'stroke', 'fillText']) {
        const original = proto[name];
        proto[name] = function(...args) {
          if (this.canvas.isConnected && this.canvas.parentElement?.classList.contains('lg-wrap')) {
            if (name === 'clearRect') this.canvas.searchTrace = { rings: [], labels: [] };
            if (name === 'beginPath') { this.searchArc = null; this.searchPath = []; }
            if (name === 'moveTo' || name === 'lineTo') this.searchPath?.push(args.slice(0, 2));
            if (name === 'arc') this.searchArc = args.slice(0, 3);
            if (this.canvas.searchTrace && name === 'stroke' && this.lineWidth === 1.5 && this.searchArc)
              this.canvas.searchTrace.rings.push(this.searchArc);
            if (this.canvas.searchTrace && name === 'stroke' && this.lineWidth === 1.5 && this.searchPath?.length === 4) {
              const xs = this.searchPath.map(p => p[0]), ys = this.searchPath.map(p => p[1]);
              this.canvas.searchTrace.rings.push([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
            }
            if (this.canvas.searchTrace && name === 'fillText') {
              const [text, x, y] = args, width = this.measureText(text).width;
              this.canvas.searchTrace.labels.push([text, x + (this.textAlign === 'left' ? width / 2 : this.textAlign === 'right' ? -width / 2 : 0), y, width]);
            }
          }
          return original.apply(this, args);
        };
      }
    });
    await page.goto(`${base}/dev.html?c=briefings&s=joint&preview=1`);
    await page.locator('.briefing-summary').waitFor();
    await page.evaluate(async () => {
      const fetch = window.fetch;
      window.searchRequests = [];
      window.copiedText = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.copiedText = text; },
      } });
      window.fetch = async (url, init) => {
        if (String(url).startsWith('/api/search') || String(url).startsWith('/api/recent')) {
          const params = new URL(url, location.href).searchParams;
          const q = params.get('q') || '';
          const offset = Number(params.get('offset') || 0);
          const limit = Number(params.get('limit') || 3);
          if (offset) await new Promise(resolve => setTimeout(resolve, 250));
          if (!q && !offset && window.recentDelay) { window.recentPending = true; await new Promise(resolve => setTimeout(resolve, window.recentDelay)); window.recentPending = false; }
          window.searchRequests.push(q);
          if (q === 'slow') await new Promise(resolve => setTimeout(resolve, 800));
          if (q === 'fail') return new Response('{}', { status: 500 });
          const titles = ['Maya Chen', 'Project notebook', 'Atlas', 'A long source title about project planning, shared notebooks, and the decisions that connect them', 'Additional project note 2', 'Additional project note 3'];
          const paths = ['projection/entities/ent_00000000000000000002.md', 'memory/project.md', 'projection/entities/ent_00000000000000000001.md', 'memory/extra-0.md', 'memory/extra-1.md', 'memory/extra-2.md'];
          for (let i = 4; i < 30; i++) { titles.push(`Older note ${i}`); paths.push(`memory/older-${i}.md`); }
          const all = q === 'none' ? [] : titles.map((title, i) => ({
            title, note: { path: paths[i], name: title, modified: [Date.parse('2026-09-13T22:47:00Z'), Date.parse('2026-09-12T15:20:00Z'), Date.parse('2026-09-13T00:00:00Z')][i] || 0 }, dir: paths[i].startsWith('projection/') ? 'projection/entities' : 'memory', snippet: 'This snippet must not appear.',
          }));
          const hits = all.slice(offset, offset + limit);
          const nextOffset = offset + limit < all.length ? offset + limit : null;
          return new Response(JSON.stringify(q ? { query: q, hits, nextOffset } : { recent: hits.map(h => ({ ...h.note, title: h.title })), nextOffset }), { headers: { 'Content-Type': 'application/json' } });
        }
        return fetch(url, init);
      };
      // Import the same HMR-versioned modules as the mounted component.
      const url = name => performance.getEntriesByType('resource').map(e => e.name).find(nameURL => new URL(nameURL).pathname === '/src/lib/' + name);
      window.liveApp = await import(url('store.svelte.ts'));
      window.floating = await import(url('floatingSearch.svelte.ts'));
      window.floating.warmRecents(-1);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    const field = page.getByRole('combobox', { name: 'Search the vault' });
    const options = page.getByRole('option');
    const viewport = page.locator('.search-viewport');
    const ringOn = title => page.waitForFunction(title => {
      const t = document.querySelector('.lg-wrap > canvas:not([aria-hidden])')?.searchTrace;
      return t?.labels.some((label, i) => {
        if (label[0] !== title) return false;
        const badge = t.labels[i - 1];
        // Memory labels center the badge and title together.
        const center = badge?.[0] === 'Memory' ? ((badge[1] - badge[3] / 2 - 5) + (label[1] + label[3] / 2)) / 2 : label[1];
        return t.rings.some(ring => Math.abs(ring[0] - center) < 1 && Math.abs(ring[1] - label[2]) < 40);
      });
    }, title);
    const initialURL = page.url();
    const initialSummary = await page.locator('.briefing-summary').textContent();
    assert.equal(await page.locator('.text-tabs, .type-chip').count(), 0);
    const noteGeometry = await page.evaluate(() => ({
      available: document.querySelector('.note-scroll').clientWidth,
      summary: document.querySelector('.briefing-summary').getBoundingClientRect().width,
      links: document.querySelector('.source-links').getBoundingClientRect().width,
    }));
    assert.ok(noteGeometry.summary > noteGeometry.available * .4 && noteGeometry.summary < noteGeometry.available * .5);
    assert.ok(noteGeometry.links > noteGeometry.available * .4 && noteGeometry.links < noteGeometry.available * .5);
    await page.keyboard.press('/');
    await page.getByRole('listbox', { name: 'Recently added' }).waitFor();
    await options.first().waitFor();
    assert.equal(await options.count(), 12);
    assert.equal(await options.first().getAttribute('aria-selected'), 'true');
    await field.fill('project');
    await options.first().waitFor();
    assert.equal(await options.count(), 6);
    assert.equal(await options.first().getAttribute('aria-selected'), 'true');
    assert.deepEqual(await page.locator('.hit-kind').allTextContents(), ['entity', 'memory', 'entity', 'memory', 'memory', 'memory']);
    assert.deepEqual(await page.locator('.hit-date').allTextContents(), ['Sep 13 15:47', 'Sep 12 08:20', 'Sep 13', '', '', '']);
    assert.equal(page.url(), initialURL);
    assert.equal(await page.locator('.briefing-summary').textContent(), initialSummary);
    assert.equal(await page.getByText('This snippet must not appear.').count(), 0);
    const geometry = await page.evaluate(() => {
      const popup = document.querySelector('.search-results');
      const field = document.querySelector('.field');
      const style = getComputedStyle(popup);
      const current = document.querySelector('.search-hit.current');
      return { bg: style.backgroundColor, shadow: style.boxShadow, border: style.borderTopWidth,
        top: popup.getBoundingClientRect().top, bottom: field.getBoundingClientRect().bottom,
        left: popup.getBoundingClientRect().left, fieldLeft: field.getBoundingClientRect().left,
        width: popup.getBoundingClientRect().width, fieldWidth: field.getBoundingClientRect().width,
        selectedBackground: getComputedStyle(current).backgroundColor, selectedText: getComputedStyle(current).color,
        rowWidth: document.querySelector(".search-hit").getBoundingClientRect().width };
    });
    assert.equal(geometry.bg, 'rgb(255, 255, 255)');
    assert.notEqual(geometry.shadow, 'none');
    assert.equal(geometry.border, '1px');
    assert.equal(geometry.selectedBackground, 'rgb(31, 35, 40)');
    assert.equal(geometry.selectedText, geometry.bg);
    assert.ok(geometry.top >= geometry.bottom);
    assert.equal(geometry.left, geometry.fieldLeft);
    assert.equal(geometry.width, geometry.fieldWidth);
    assert.ok(geometry.rowWidth < geometry.fieldWidth && geometry.rowWidth > geometry.fieldWidth - 36);
    assert.ok(geometry.fieldWidth > 1000);
    assert.equal(await viewport.evaluate(el => el.clientHeight), 126);
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await page.waitForFunction(() => document.querySelectorAll('[role=option]').length === 6);
    assert.equal(await options.nth(3).getAttribute('aria-selected'), 'true');
    assert.ok(await viewport.evaluate(el => el.scrollTop > 0));
    assert.equal(await viewport.evaluate(el => el.clientHeight), 126);
    await field.fill('');
    await options.first().waitFor();
    assert.equal(await options.count(), 12);
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const spinner = page.getByRole('status', { name: 'Loading more', exact: true });
    await spinner.waitFor();
    const spinnerRect = await spinner.boundingBox();
    const popupRect = await page.locator('.search-results').boundingBox();
    assert.ok(spinnerRect.y >= popupRect.y && spinnerRect.y + spinnerRect.height <= popupRect.y + popupRect.height);
    await page.screenshot({ path: '/private/tmp/recent-loading-spinner.png' });
    await page.waitForFunction(() => document.querySelectorAll('[role=option]').length === 24);
    assert.equal(await viewport.evaluate(el => el.clientHeight), 126);
    await field.fill('project');
    await options.first().waitFor();
    assert.equal(await options.count(), 6);
    assert.equal(await viewport.evaluate(el => el.scrollTop), 0);
    await ringOn('Maya Chen');
    await options.nth(1).hover();
    await ringOn('Project notebook');
    assert.equal(await page.locator('.note-title').textContent(), 'Atlas');
    assert.equal(page.url(), initialURL);
    await field.press('ArrowUp');
    assert.equal(await options.first().getAttribute('aria-selected'), 'true');
    await ringOn('Maya Chen');
    await page.screenshot({ path: '/private/tmp/floating-search-desktop.png' });
    await field.press('Enter');
    await page.waitForURL(/ent_00000000000000000002.md/);
    await page.waitForFunction(() => document.querySelector('.note-title')?.textContent === 'Maya Chen');
    assert.equal(await page.locator('.search-results').count(), 0);
    assert.equal(await field.evaluate(el => el === document.activeElement), false);
    await page.keyboard.press('j');
    assert.equal(await page.locator('.source-link.lk-on .link-title').count(), 1);
    // Escape dismisses only the search; Tab uses normal focus navigation.
    await page.keyboard.press('/');
    await field.fill('project');
    await options.first().waitFor();
    await field.press('ArrowDown');
    assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
    await field.fill('new query');
    await options.first().waitFor();
    assert.equal(await options.first().getAttribute('aria-selected'), 'true');
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    assert.equal(await options.nth(2).getAttribute('aria-selected'), 'true');
    await field.press('ArrowUp');
    assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
    await field.press('Escape');
    assert.equal(await page.locator('.search-results').count(), 0);
    assert.equal(await page.locator('.note-title').textContent(), 'Maya Chen');
    await page.keyboard.press('/');
    await options.first().waitFor();
    await field.press('Tab');
    assert.equal(await field.evaluate(el => el === document.activeElement), false);
    await page.keyboard.press('ArrowDown');
    assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.note-title').textContent(), 'Maya Chen');
    // A new query cannot open the previous query's hits while pending.
    await field.focus();
    await field.fill('slow');
    await page.getByRole('status', { name: 'Searching', exact: true }).waitFor();
    assert.equal(await page.getByText('Searching…', { exact: true }).count(), 0);
    await field.press('Enter');
    assert.match(page.url(), /ent_00000000000000000002.md/);
    assert.equal(await options.count(), 0);
    await field.fill('none');
    await page.getByText('No results.', { exact: true }).waitFor();
    await field.fill('fail');
    await page.locator('.search-results .retry').waitFor();
    await page.locator('.search-results .retry').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.searchRequests.filter(q => q === 'fail').length === 2);
    await page.locator('.search-results .retry').waitFor();
    await field.fill('project');
    await options.first().waitFor();
    await options.nth(1).click();
    await page.waitForURL(/memory\/project.md/);
    await page.locator('.briefing-summary').waitFor();
    // A new vault revision revalidates recents without blanking the cached rows.
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Project notebook");
    await field.focus();
    await field.fill('');
    await options.first().waitFor();
    await page.evaluate(async () => {
      window.recentDelay = 800;
      window.liveApp.app.rev++;
    });
    await page.waitForFunction(() => window.recentPending);
    assert.equal(await options.count(), 12);
    assert.equal(await page.getByRole('status', { name: 'Loading recent items', exact: true }).count(), 0);
    await field.press('ArrowDown');
    await page.waitForFunction(() => !window.recentPending);
    assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
    await field.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('/');
    await field.fill('project');
    await options.first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await viewport.evaluate(el => el.clientHeight), 186);
    const mobileLayout = await options.first().evaluate(el => {
      const title = el.querySelector('.hit-title').getBoundingClientRect();
      const kind = el.querySelector('.hit-kind').getBoundingClientRect();
      const date = el.querySelector('.hit-date').getBoundingClientRect();
      return { stacked: kind.top >= title.bottom && date.top >= title.bottom, metadataFits: kind.right < date.left };
    });
    assert.deepEqual(mobileLayout, { stacked: true, metadataFits: true });
    await page.screenshot({ path: '/private/tmp/floating-search-mobile.png' });
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    assert.equal(await options.nth(3).getAttribute('aria-selected'), 'true');
    assert.equal(await options.nth(3).locator('.hit-title > span').evaluate(el => el.scrollWidth > el.clientWidth), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      document.querySelector('.stage.app').dataset.theme = 'dusk';
    });
    const dark = await page.locator('.search-results').evaluate(el => ({
      background: getComputedStyle(el).backgroundColor,
      animation: getComputedStyle(el).animationName,
      selection: getComputedStyle(el.querySelector('.search-hit.current')).backgroundColor,
      text: getComputedStyle(el.querySelector('.search-hit.current')).color,
    }));
    assert.equal(dark.animation, 'none');
    assert.equal(dark.text, dark.background);
    assert.notEqual(dark.selection, dark.background);
    await page.screenshot({ path: '/private/tmp/floating-search-dark.png' });
    await field.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.drawer'));
    assert.equal(await page.locator('.text-tabs').count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ floatingSearch: 'pass', threeRows: 'pass', immediateEnter: 'pass', selectionPreserved: 'pass', keyboard: 'pass', tagsAndReset: 'pass', canvasPreviews: 'pass', staleAndFailedSearch: 'pass', mobile: 'pass', errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
