/** The real app's graph and text share one selection, including Zen's Ctrl-click. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    // These scenes use fakeApi exclusively; never allow a real backend request.
    await page.route("**/api/**", route => route.abort());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const proto = CanvasRenderingContext2D.prototype;
      for (const name of ['clearRect', 'arc', 'fillText']) {
        const original = proto[name];
        proto[name] = function(...args) {
          if (this.canvas.isConnected && !this.canvas.classList.contains('gpu-edges') && !this.canvas.classList.contains('gpu-trails')) {
            if (name === 'clearRect') this.canvas.trace = { points: [], labels: [] };
            if (this.canvas.trace && name === 'arc' && args[2] < 15) this.canvas.trace.points.push(args.slice(0, 3));
            if (this.canvas.trace && name === 'fillText') this.canvas.trace.labels.push(args.slice(0, 3));
          }
          return original.apply(this, args);
        };
      }
    });
    const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
    const atlas = 'projection/entities/ent_00000000000000000001.md';
    const maya = 'projection/entities/ent_00000000000000000002.md';
    await page.goto(`${base}/dev.html?c=briefings&s=joint&preview=1`);
    await page.locator('.briefing-summary').waitFor();
    await page.waitForTimeout(1800);
    const state = () => page.evaluate(async () => {
      const { app } = await import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/lib/store.svelte.ts')).name);
      return JSON.parse(JSON.stringify(app.graphView));
    });
    const setState = value => page.evaluate(async value => {
      const { app } = await import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/lib/store.svelte.ts')).name);
      app.graphView = value;
    }, value);
    await page.evaluate(() => {
      const fetch = window.fetch;
      window.briefingRequests = [];
      window.fetch = async (url, init) => {
        if (url === '/api/note/briefing') {
          window.briefingRequests.push(JSON.parse(init.body));
          const response = await fetch(url, init);
          // Deliberately return a stale response even after AbortController fires.
          if (window.delayNextBriefing) {
            window.delayNextBriefing = false;
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
          return response;
        }
        return fetch(url, init);
      };
    });
    // Relationship rows share the graph's additive selection gesture.
    await page.locator(`.source-link[data-path="${maya}"]`).click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => document.querySelector('.note-title')?.textContent.includes(' · '));
    assert.deepEqual((await state()).selected.sort(), ['maya', atlas].sort());
    assert.equal(await page.locator('.note-title').textContent(), 'Maya Chen · Atlas');
    // Restore the single selection so the canvas gesture remains covered too.
    await setState({ selected: [atlas], excluded: [] });
    await page.waitForFunction(() => document.querySelector('.note-title')?.textContent === 'Atlas');
    await page.locator(`.source-link[data-path="${maya}"]`).waitFor();
    await page.waitForTimeout(1800);
    const canvas = page.locator('.lg-wrap > canvas:not([aria-hidden])');
    const box = await canvas.boundingBox();
    async function pointFor(title) {
      // Selected labels are already drawn. Otherwise reveal one dot at a time.
      const labelled = await canvas.evaluate((c, title) => {
        const label = c.trace.labels.find(p => p[0] === title);
        if (!label) return null;
        return c.trace.points.filter(p => Math.abs(p[0] - label[1]) < 1).sort((a, b) => Math.abs(a[1] - label[2]) - Math.abs(b[1] - label[2]))[0];
      }, title);
      if (labelled) return labelled;
      const points = await canvas.evaluate(c => [...new Map(c.trace.points.map(p => [p.slice(0, 2).map(v => v.toFixed(2)).join(','), p])).values()]);
      for (const p of points) {
        await page.mouse.move(box.x + p[0], box.y + p[1]);
        await page.waitForTimeout(240);
        if (await canvas.evaluate((c, title) => c.trace.labels.some(p => p[0] === title), title)) return p;
      }
      throw new Error(`No visible graph point for ${title}`);
    }
    const mayaPoint = await pointFor('Maya Chen');
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + mayaPoint[0], box.y + mayaPoint[1]);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => document.querySelector('.note-title')?.textContent.includes(' · '));
    await page.locator('.briefing-summary').waitFor();
    assert.deepEqual((await state()).selected.sort(), ['maya', atlas].sort());
    assert.equal(await page.locator('.note-title').textContent(), 'Maya Chen · Atlas');
    assert.equal(await page.locator('.text-tabs').count(), 0);
    assert.equal(await page.locator('.source-link').count(), 7);
    assert.equal(await page.locator('.link-description').count(), 7);
    assert.equal(await page.locator(`.source-link[data-path="${atlas}"], .source-link[data-path="${maya}"]`).count(), 0);
    assert.equal(await page.locator('.note-chips, .original-note').count(), 0);
    const titles = await page.locator('.link-title').allTextContents();
    for (const title of titles) {
      await page.keyboard.press('j');
      assert.equal(await page.locator('.source-link.lk-on .link-title').textContent(), title);
    }
    assert.equal(await page.locator('.source-link.lk-on').count(), 1);
    await page.locator('.note-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/private/tmp/selection-briefing.png' });
    await page.mouse.move(1400, 1050);
    await page.waitForTimeout(1800);
    const atlasPoint = await pointFor('Atlas');
    const event = { button: 2, buttons: 1, ctrlKey: true, clientX: box.x + atlasPoint[0], clientY: box.y + atlasPoint[1] };
    await canvas.dispatchEvent('mousedown', event);
    await canvas.dispatchEvent('contextmenu', event);
    await canvas.dispatchEvent('pointerup', { ...event, buttons: 0 });
    await canvas.dispatchEvent('mouseup', { ...event, buttons: 0 });
    await page.waitForFunction(() => document.querySelector('.note-title')?.textContent === 'Maya Chen');
    await page.locator('.briefing-summary').waitFor();
    assert.deepEqual(await state(), { selected: ['maya'], excluded: [atlas] });
    assert.match(page.url(), /ent_00000000000000000002.md/);
    assert.equal(await page.locator(`.source-link[data-path="${atlas}"]`).count(), 0);
    assert.equal(await page.locator('.discuss-shortcut').count(), 1);
    // Restore declaratively, then prune a shared neighbor. The text uses the same state.
    await setState({ selected: [atlas, 'maya'], excluded: ['memory/project.md'] });
    await page.locator('.briefing-summary').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.source-link').length === 6);
    assert.equal(await page.locator('.source-link[data-path="memory/project.md"]').count(), 0);
    // Quick changes debounce to one request; a superseded response never repaints.
    await page.evaluate(() => { window.briefingRequests = []; });
    await setState({ selected: [atlas, 'maya', 'memory/project.md'], excluded: [] });
    await page.waitForTimeout(100);
    await setState({ selected: [atlas, 'maya'], excluded: [] });
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(() => window.briefingRequests.length), 1);
    await page.evaluate(() => { window.delayNextBriefing = true; });
    await setState({ selected: [atlas, 'maya', 'memory/project.md'], excluded: [] });
    await page.waitForTimeout(600);
    await setState({ selected: ['maya'], excluded: [atlas] });
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('.note-title').textContent(), 'Maya Chen');
    assert.equal(await page.locator('.source-link').count(), 4);
    // A revisit paints the completed summary AND PageRank order in the next frame,
    // before the 150ms debounce or a deliberately delayed server response.
    const cachedSingle = await page.locator('.briefing-summary').textContent();
    await setState({ selected: [atlas, 'maya'], excluded: [] });
    await page.waitForTimeout(350);
    await page.evaluate(() => { window.delayNextBriefing = true; });
    const revisit = await page.evaluate(async ({ atlas }) => {
      const { app } = await import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/lib/store.svelte.ts')).name);
      const start = performance.now();
      app.graphView = { selected: ['maya'], excluded: [atlas] };
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { ms: performance.now() - start, summary: document.querySelector('.briefing-summary')?.textContent,
        busy: document.querySelector('.briefing')?.getAttribute('aria-busy'), descriptions: document.querySelectorAll('.link-description').length };
    }, { atlas });
    assert.equal(revisit.summary, cachedSingle);
    assert.equal(revisit.busy, 'false');
    assert.equal(revisit.descriptions, 4);
    assert.ok(revisit.ms < 150, `Cached revisit took ${revisit.ms}ms`);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.briefing-summary').textContent(), cachedSingle);
    assert.equal(await page.locator('.briefing-spinner').count(), 0);
    console.log(`Cached revisit: ${revisit.ms.toFixed(1)}ms to paint, with the backend response delayed 1500ms.`);
    await page.waitForTimeout(1600);
    // Enter starts a fresh selection at the link, clearing prior exclusions.
    await page.keyboard.press('j');
    const target = await page.locator('.source-link.lk-on').getAttribute('data-path');
    await page.keyboard.press('Enter');
    await page.waitForFunction(target => decodeURIComponent(location.hash).endsWith(target), target);
    await page.locator('.briefing-summary').waitFor();
    assert.equal((await state()).selected.length, 1);
    assert.deepEqual((await state()).excluded, []);
    await page.setViewportSize({ width: 390, height: 844 });
    await setState({ selected: [atlas, 'maya', 'memory/project.md'], excluded: [] });
    await page.locator('.briefing-summary').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.match(await page.locator('.note-title').textContent(), /Project notebook/);
    await setState({ selected: [], excluded: ['maya', atlas] });
    await page.waitForFunction(() => !document.querySelector('.note-title'));
    assert.deepEqual(await state(), { selected: [], excluded: ['maya', atlas] });
    assert.equal(await page.getByLabel('Graph selection', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: text and graph Shift-click, Zen Ctrl-click, joint titles/summary/links, up to ten descriptions, exclusions, single-selection fallback, keyboard navigation, debouncing, immediate cached revisits, stale responses, mobile, clear; no runtime errors.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
