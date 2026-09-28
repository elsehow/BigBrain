const { createRequire } = require('node:module');
const { chromium } = createRequire(process.cwd() + '/package.json')('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:5201/', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="app"></div><script type="module">
      import { installFakeApi, setVaultState, BRIEFINGS } from '/src/dev/fakeApi.ts';
      installFakeApi(); setVaultState(structuredClone(BRIEFINGS.many));
      await import('/src/main.ts');
    </script>` }));
    await page.goto('http://127.0.0.1:5201/');
    await page.locator('.lg-wrap').waitFor();
    assert.equal(await page.locator('.sidebar-study-switch').count(), 0);
    assert.equal(await page.locator('.sidebar-camera').count(), 0);
    await page.keyboard.press('j');
    await page.locator('.memory-preview .briefing-summary').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-sidebar-workbench'), 'closed');
    await page.keyboard.press('Enter');
    await page.locator('.drawer:not(.sidebar-quick) .briefing-summary').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-sidebar-workbench'), 'open');
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    await page.locator('#topbar input').waitFor();
    assert.equal(await page.locator('#topbar input').evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
    console.log('PASS: production entry mounts memory sidebar, no preview controls, search focus works');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
