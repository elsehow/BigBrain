// The notification stack holds the window's top-right corner, and nothing it
// sits over is a control (#167: it covered Settings' Configure, and every
// control down Settings' right side). Field over the fabricated vault, with
// lapsed connections and lapsed accounts raising notices, at the desktop
// app's window sizes and a phone's, light and dark: no button, field or link
// of a view meets a notice, nothing covers a notice's own buttons, and
// Configure takes a click while a notice shows. Also with one and two strips
// over the top bar (an update, a provider out of credits), and with the
// chat's split dragged as wide as it goes.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5279';

/** Each view control whose visible part meets a notice's visible part, and
 * each notice button something else covers. */
const overlaps = page => page.evaluate(() => {
  const stack = document.querySelector('.notification-stack');
  const shown = el => {
    const b = el.getBoundingClientRect();
    let r = { left: b.left, right: b.right, top: Math.max(b.top, 0), bottom: Math.min(b.bottom, innerHeight) };
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (!/auto|scroll|hidden/.test(s.overflowX + s.overflowY)) continue;
      const c = p.getBoundingClientRect();
      r = { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) };
    }
    return r.right > r.left && r.bottom > r.top ? r : null;
  };
  const sheets = [...document.querySelectorAll('.notification-sheet')].map(shown).filter(Boolean);
  const covered = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, summary, [role=switch], [role=button], [role=separator], iframe')) {
    if (stack?.contains(el) || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).pointerEvents === 'none') continue;
    const r = shown(el);
    if (r && sheets.some(s => r.left < s.right && r.right > s.left && r.top < s.bottom && r.bottom > s.top))
      covered.push((el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40));
  }
  const blocked = [...(stack?.querySelectorAll('button') ?? [])].filter(b => {
    const r = shown(b);
    return r && !b.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2));
  }).map(b => b.textContent.trim());
  return { sheets: sheets.length, covered, blocked };
});

(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    for (const [width, height, scheme, strips] of [[1280, 1000, 'light', ''], [1280, 1000, 'dark', '&update'], [1440, 900, 'light', ''],
      [1864, 1100, 'dark', '&update&credits'], [390, 844, 'light', '&update&credits']]) {
      const at = `${width}×${height} ${scheme}${strips.replaceAll('&', ' ')}`, scene = `${base}/field-workbench.html?view=field&expired-clients=many&lapsed-accounts=many${strips}`;
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const clear = async scene => {
        const found = await overlaps(page);
        assert(found.sheets >= 1, `${scene} at ${at}: a notice shows`);
        assert.deepEqual(found.covered, [], `${scene} at ${at}: no control under a notice`);
        assert.deepEqual(found.blocked, [], `${scene} at ${at}: nothing over a notice's buttons`);
      };
      await page.goto(`${scene}#/integrations`);
      await page.locator('[data-notice-id="connection:expired"]').waitFor();
      await page.locator('[data-notice-id="integration:reconnect"]').waitFor();
      if (strips) {
        // the stack starts below the strips over the top bar, however many there are
        await page.locator('.update .nudge').waitFor();
        if (strips.includes('credits')) await page.locator('.update .credits').waitFor();
        await page.waitForTimeout(300); // the nudge's slide in
        const [bar, stack] = await Promise.all(['.update', '.notification-stack'].map(s => page.locator(s).first().boundingBox()));
        assert(stack.y >= bar.y + bar.height, `the stack starts below the strips at ${at}`);
      }
      const yours = page.getByRole('region', { name: 'Your integrations' }), scroller = page.locator('aside.panel .settings:has(> .rail)');
      await yours.getByRole('button', { name: 'Configure', exact: true }).waitFor();
      await clear('Settings → integrations');
      // every settings screen, top and bottom: each has controls down its right side
      for (const screen of ['connectedClients', 'agents', 'vaultSettings', 'security', 'diagnostics', 'integrations']) {
        await page.evaluate(view => { location.hash = `#/${view}`; }, screen);
        await scroller.locator('> .content > .list').waitFor();
        await page.waitForTimeout(300);
        await clear(`Settings → ${screen}`);
        await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await clear(`Settings → ${screen}, scrolled`);
      }
      if (width >= 1152) {
        // beside the notices, Settings keeps its own width: nothing scrolls sideways
        const settings = await scroller.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
        assert(settings.scroll <= settings.width, `Settings fits beside the notices at ${at}`);
      }
      // Configure takes the click with the notices still up
      await scroller.evaluate(el => { el.scrollTop = 0; });
      await yours.getByRole('button', { name: 'Configure', exact: true }).click({ timeout: 5000 });
      await page.getByRole('region', { name: 'hardcover accounts' }).waitFor();
      assert.equal(await page.locator('[data-notice-id="connection:expired"]').count(), 1, 'the notice is still up');
      // the field, and a source opened beside its chat: the desktop's view starts below the notices
      await page.goto(scene);
      await page.locator('[data-notice-id="connection:expired"]').waitFor();
      await page.locator('.feed.sorted .row').nth(2).waitFor();
      await clear('Field');
      await page.locator('.feed.sorted .row').nth(1).evaluate(row => row.click());
      await page.getByText('Not kept until you send').waitFor();
      await page.getByRole('button', { name: 'Close Atlas survey update', exact: true }).waitFor();
      await clear('Desktop');
      if (width >= 1152) {
        // the split dragged as far right as it goes: the chat stops short of the notices' column
        const split = await page.locator('.split').boundingBox();
        await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2);
        await page.mouse.down();
        await page.mouse.move(width - 20, split.y + split.height / 2, { steps: 8 });
        await page.mouse.up();
        const [chat, stack] = await Promise.all(['.chat', '.notification-stack'].map(s => page.locator(s).boundingBox()));
        assert(Number(await page.evaluate(() => localStorage.getItem('v2.chatWidth'))) + 34 > stack.x, `the drag asked for the stack's column at ${at}`);
        assert(chat.x + chat.width <= stack.x, `the chat keeps left of the notices at ${at}`);
        await clear('Desktop, split dragged wide');
        // (by script: with two strips up, they sit over the chat's own top row, a separate matter)
        await page.locator('.chat .find', { hasText: '1 view' }).evaluate(button => button.click());
        await page.locator('.chat.solo').waitFor();
        await clear('Lone chat, split dragged wide');
      }
      if (width === 1280 && scheme === 'light') {
        // a tall stack (three captures more) stops short of the feed, the key hints and Feedback
        await page.keyboard.press('Escape');
        await page.getByText('Not kept until you send').waitFor({ state: 'detached' });
        await page.evaluate(() => {
          const files = new DataTransfer();
          for (const name of ['alpha-notes.txt', 'beta-sketch.txt', 'gamma-ledger.txt']) files.items.add(new File(['Sample text for the notice preview.'], name, { type: 'text/plain' }));
          const drop = new Event('drop');
          Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: files.files, items: [] } });
          window.dispatchEvent(drop);
        });
        await page.locator('[data-notice-kind="capture"]').nth(2).waitFor();
        await page.mouse.move(640, 500); await page.mouse.move(650, 510);
        await page.locator('.feedback-trigger.visible').waitFor();
        await clear('Field with five notices');
      }
      assert.deepEqual(errors, [], `no page errors at ${at}`);
      await context.close();
    }
    console.log('Notice placement: no view control under a notice passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
