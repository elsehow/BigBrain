// Run against bin/ui-diagnostics.ts (read-only proxy to an existing local engine).
const { webkit } = require('playwright-core');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const script = readFileSync(require('node:path').join(__dirname, '../../desktop/src-tauri/src/ui-diagnostics.js'), 'utf8');
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    for (const mode of ['on', 'graph-off']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(mode => {
        window.__BIGBRAIN_UI_DIAGNOSTICS_MODE__ = mode;
        window.diagnosticSamples = [];
        window.windowStateQueries = 0;
        window.__TAURI__ = { core: { invoke: async (command, args) => {
          if (command === 'ui_diagnostic') window.diagnosticSamples.push(args.sample);
          if (command === 'window_is_maximized') {
            window.windowStateQueries++;
            await new Promise(resolve => setTimeout(resolve, 150));
            return false;
          }
        } } };
      }, mode);
      await page.addInitScript({ content: script });
      await page.goto(process.env.UI_DIAGNOSTIC_URL || 'http://127.0.0.1:53919/');
      await page.locator('.workspace-menu-hint').first().waitFor({ state: 'attached' });
      if (mode === 'on') await page.waitForFunction(() => document.querySelectorAll('.g-canvas canvas').length > 0);
      else assert.equal(await page.locator('.g-canvas canvas').count(), 0);
      for (const key of ['j', 'Enter', 'Escape', 'r', 'Escape']) {
        await page.keyboard.press(key); await page.waitForTimeout(200);
      }
      await page.waitForTimeout(1200);
      const samples = await page.evaluate(() => window.diagnosticSamples);
      assert(samples.some(s => s.event === 'input_key'));
      assert(samples.some(s => s.event === 'input_settled'));
      assert(samples.some(s => s.event === 'heartbeat'));
      if (mode === 'on') assert(samples.some(s => s.event === 'heartbeat' && s.values[4] > 0));
      else assert(samples.filter(s => s.event === 'heartbeat').every(s => s.values[4] === 0));
      assert.deepEqual(errors, []);
      assert(samples.every(s => Object.keys(s).every(key => ['event', 'id', 'values'].includes(key))));
      const before = await page.evaluate(() => {
        const count = window.windowStateQueries;
        for (let i = 0; i < 30; i++) window.dispatchEvent(new Event('resize'));
        return count;
      });
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => window.windowStateQueries), before + 1, 'resize events share one pending native query');
      console.log(`${mode}: input/frame/heartbeat capture passed; graph isolation passed`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
