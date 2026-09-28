/** Production shell: duplicate review must receive input above the graph even with translucent panels.
 * Every backend read/write uses the workbench's fabricated vault. */
const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    for (const theme of ['web', 'default', 'dusk']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/**', r => r.abort());
      await page.goto(`${base}/sidebar-workbench.html`);
      await page.locator('.g-canvas canvas').first().waitFor();
      await page.evaluate(async () => {
        const { setVaultState, BRIEFINGS } = await import('/src/dev/fakeApi.ts');
        const { app } = await import('/src/lib/store.svelte.ts');
        const state = structuredClone(BRIEFINGS.many); state.hash = '/';
        state.folds = [
          { canonical: 'fold-a', why: 'Sample spelling variants.', members: [{ id: 'fold-a', label: 'Sample Project', assertions: 10 }, { id: 'fold-b', label: 'Sample project alias', assertions: 3 }] },
          { canonical: 'fold-c', why: 'Sample abbreviated name.', members: [{ id: 'fold-c', label: 'Example Lab', assertions: 8 }, { id: 'fold-d', label: 'EL', assertions: 2 }] },
        ];
        setVaultState(state); app.rev++;
      });
      const panel = page.locator('.home-folds .folds'); await panel.waitFor(); await page.waitForTimeout(1500);
      const target = page.getByRole('radio', { name: 'Sample project alias 3' });
      const receivesInput = await target.evaluate(el => {
        const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      await page.screenshot({ path: `/tmp/graph-fold-panel-${theme}.png` });
      const panelRect = await panel.boundingBox(), toolbarRect = await page.locator('#topbar').boundingBox();
      assert(panelRect.y >= toolbarRect.y + toolbarRect.height, 'review starts below the fixed toolbar');
      assert(receivesInput, `${theme}: duplicate controls receive clicks above the graph`);
      await page.evaluate(async theme => { const { setChoice } = await import('/src/lib/theme.ts'); setChoice(theme); }, theme);
      const surface = await panel.evaluate(el => {
        const c = document.createElement('canvas'), ctx = c.getContext('2d');
        ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[3];
      });
      assert.equal(surface, 199, 'review shares 78% panel opacity without yielding pointer events');
      // These actions reach fakeApi, never a real entity-fold endpoint.
      await target.click(); await page.getByRole('radio', { name: 'Sample project alias 3', checked: true }).waitFor();
      await page.getByRole('button', { name: 'ACCEPT', exact: true }).first().click();
      await page.getByRole('radio', { name: 'Sample project alias 3' }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Not the same thing — remove EL', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
      assert(await page.locator('.g-canvas canvas').count() > 0, 'graph remains after review');
      await page.keyboard.press('j'); await page.waitForTimeout(800);
      assert(await page.locator('.graph-renderer').getAttribute('data-selected'), 'j/k resumes after review');
      assert.deepEqual(errors, []); await page.close();
      console.log(`PASS: ${theme} production-shell review stacking, shared glass, canonical pick, accept, reject and return to graph`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
