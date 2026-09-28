// Start the UI workbench, then run: node test/support/graphPilotContext.browser.cjs
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const p = CanvasRenderingContext2D.prototype;
      for (const name of ['clearRect', 'beginPath', 'arc', 'fill']) {
        const original = p[name];
        p[name] = function (...args) {
          if (this.canvas.matches('.lg-wrap > canvas:not([aria-hidden])')) {
            if (name === 'clearRect') this.canvas.dotInk = [];
            if (name === 'beginPath') this.smallDot = false;
            if (name === 'arc' && args[2] > 0 && args[2] < 15) this.smallDot = true;
            if (name === 'fill' && this.smallDot) (this.canvas.dotInk ??= []).push(this.globalAlpha);
          }
          return original.apply(this, args);
        };
      }
    });
    const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
    await page.goto(`${base}/dev.html?c=LinkGraph&sample=pilots&preview=1`);
    const canvas = page.locator('.lg-wrap > canvas:not([aria-hidden])');
    const ink = () => canvas.evaluate(c => c.dotInk ?? []);
    const dimmed = values => values.filter(a => Math.abs(a - 0.1) < 0.01).length;
    await page.waitForFunction(() => document.querySelector('.lg-wrap > canvas:not([aria-hidden])')?.dotInk?.some(a => Math.abs(a - 0.1) < 0.01));
    const active = await ink();
    assert(dimmed(active) > 20, 'Unrelated notes dim with real Pilot data');
    assert(active.some(a => a === 1), 'Pilot context remains fully visible');
    await page.screenshot({ path: '/tmp/pilot-graph-active.png' });
    await page.getByLabel('Prioritize Pilot context', { exact: true }).uncheck();
    await page.waitForTimeout(500);
    assert.equal(dimmed(await ink()), 0, 'Disabling priority restores the overview');
    await page.getByLabel('Prioritize Pilot context', { exact: true }).check();
    await page.waitForTimeout(500);
    assert(dimmed(await ink()) > 20, 'Re-enabling priority restores context emphasis');
    await page.getByLabel('Pilots active', { exact: true }).uncheck();
    await page.waitForTimeout(500);
    assert.equal(dimmed(await ink()), 0, 'Closing the Pilots releases background dimming');
    await page.screenshot({ path: '/tmp/pilot-graph-closed.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: real Pilot context dims unrelated nodes; priority toggles and closure restore the overview; no runtime errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
