const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5204/sidebar-workbench.html');
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.locator('.pilot-row').first().waitFor();
    assert.equal(await page.getByRole('scrollbar', { name: 'Scroll agents' }).count(), 0);
    await page.evaluate(async () => {
      const { chat } = await import('/src/lib/pilotChat.svelte.ts');
      const sample = JSON.parse(JSON.stringify(chat.sessions[0]));
      chat.sessions = Array.from({ length: 40 }, (_, i) => ({
        ...sample, id: 'pilot-' + i.toString(16).padStart(32, '0'), title: 'Agent ' + i,
      }));
    });
    const bar = page.getByRole('scrollbar', { name: 'Scroll agents' });
    await bar.waitFor();
    assert.equal(await bar.getAttribute('aria-controls'), 'pilot-list');
    const list = page.locator('#pilot-list');
    await bar.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('#pilot-list').scrollTop > 0);
    assert.equal(await page.locator('.pilot-row.selected').count(), 0, 'Scrollbar keys must not select an agent');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('#pilot-list').scrollTop === 0);
    const box = await bar.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * .8);
    assert.ok(await list.evaluate(el => el.scrollTop > 0), 'Track click scrolls');
    await list.hover();
    const before = await list.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(before => document.querySelector('#pilot-list').scrollTop < before, before);
    await page.locator('.pilot-row').first().focus();
    await page.keyboard.press('End');
    assert.equal(await page.locator('.pilot-row.selected .row-heading strong').innerText(), 'Agent 39');
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.waitForFunction(() => {
      const bar = document.querySelector('.pilots-pane .block-scrollbar');
      const list = document.querySelector('#pilot-list');
      return Math.abs(bar.getBoundingClientRect().height - list.clientHeight) < 1;
    });
    await page.keyboard.press('r');
    await page.getByRole('scrollbar', { name: 'Scroll results' }).waitFor();
    assert.equal(await page.getByRole('scrollbar', { name: 'Scroll results' }).getAttribute('aria-controls'), 'search-results');
    assert.deepEqual(errors, []);
    console.log('PASS: production shell Agents scrollbar, short/long lists, keyboard, track, wheel, resize, and Recents');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
