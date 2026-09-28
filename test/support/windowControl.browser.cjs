const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => {
      window.expanded = false;
      window.__TAURI__ = { core: { invoke: async command => {
        if (command === 'window_is_maximized') return window.expanded;
        if (command === 'window_toggle_maximize') return window.expanded = !window.expanded;
      } } };
    });
    await page.goto(process.env.WORKBENCH_URL || 'http://127.0.0.1:5202/sidebar-workbench.html');
    const button = page.locator('.window-corner');
    await button.waitFor();
    const rect = await button.boundingBox();
    assert.equal(Math.round(rect.x + rect.width), 1416);
    assert.equal(rect.y, 28);
    await page.mouse.move(1200, 200);
    await button.click();
    assert.equal(await button.getAttribute('aria-label'), 'Restore window');
    await page.keyboard.press('a');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.expanded), true);
    await page.mouse.move(900, 400);
    await page.waitForTimeout(3000);
    assert.equal(await button.evaluate(el => getComputedStyle(el).opacity), '0');
    await page.mouse.move(1000, 400);
    await page.waitForTimeout(300);
    assert.equal(await button.evaluate(el => getComputedStyle(el).opacity), '1');
    await button.click();
    assert.equal(await page.evaluate(() => window.expanded), false);
    await page.keyboard.press('a');
    await page.locator('.pilot-row').first().click();
    const composer = page.getByRole('textbox', { name: 'Message Pilot' });
    await composer.waitFor();
    await composer.focus();
    await page.keyboard.type('hl');
    assert.equal(await composer.innerText(), 'hl');
    await composer.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: '¬', code: 'KeyL', altKey: true, bubbles: true, cancelable: true })));
    assert.equal(await page.locator('html').getAttribute('data-sidebar-expanded'), 'true');
    const close = await page.locator('.sidebar-close').boundingBox();
    assert.equal(Math.round(close.x + close.width), 1416);
    assert.equal(await composer.innerText(), 'hl');
    const bounds = await page.evaluate(() => {
      const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x:r.x, right:r.right }; };
      return { title:rect('.pilot-panel header > strong'), text:rect('.reading-column'), editor:rect('.editor'), send:rect('.composer-actions') };
    });
    assert.equal(bounds.title.x, bounds.text.x);
    assert.equal(bounds.editor.x, bounds.text.x);
    assert.equal(bounds.send.right, bounds.text.right);
    await page.keyboard.press('Alt+h');
    assert.equal(await page.locator('html').getAttribute('data-sidebar-expanded'), 'false');
    assert.equal(await composer.evaluate(el => el === document.activeElement), true);
    const columnAligned = async () => page.evaluate(() => {
      const x = selector => document.querySelector(selector).getBoundingClientRect().x;
      return Math.abs(x('.pilot-panel header > strong') - x('.reading-column')) < 1
        && Math.abs(x('.editor') - x('.reading-column')) < 1;
    });
    assert(await columnAligned());
    const model = page.locator('.model-command');
    await model.click();
    const done = page.getByRole('button', { name: 'Close model settings', exact: true });
    assert(await done.isEnabled());
    await done.click();
    await model.waitFor();
    await model.click();
    await page.locator('.inline-backend select').first().focus();
    await page.keyboard.press('Escape');
    await model.waitFor();
    assert.equal(await page.locator('.pilot-panel').count(), 1);
    assert.equal(await page.locator('.inline-backend').count(), 0);
    assert(await columnAligned());
    await composer.focus();
    for (let i = 0; i < 15; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type('next line'); }
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(100);
    const scroll = await composer.evaluate(el => ({ top:el.scrollTop, height:el.scrollHeight, visible:el.clientHeight, bottom:el.getBoundingClientRect().bottom }));
    assert(scroll.height - scroll.top - scroll.visible <= 1);
    assert(scroll.bottom <= 1000);
    console.log('Model editor: unchanged check closes; Escape returns to chat; both layouts align');
    console.log('Agent pane: Option-H/L from composer and fullscreen padding passed');
    console.log('Window control: position, reveal, toggle, and Escape passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
