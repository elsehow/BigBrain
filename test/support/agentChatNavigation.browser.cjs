const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.WORKBENCH_URL || 'http://127.0.0.1:5225/sidebar-workbench.html');
    await page.locator('.lg-wrap').waitFor();
    await page.evaluate(async () => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (new URL(String(args[0]), location.href).pathname !== '/api/pilot/chat') return response;
        const data = await response.json();
        for (const session of data.sessions) {
          session.revision += 100;
          session.messages = Array.from({ length: 6 }, (_, i) => [
            { id: `user-${i}`, role: 'user', text: `Question ${i}`, at: session.created },
            { id: `answer-${i}`, role: 'assistant', text: Array(24).fill(`Answer ${i}: a paragraph to make this conversation scroll.`).join('\n\n'), at: session.created },
          ]).flat();
        }
        return new Response(JSON.stringify(data));
      };
      const { refreshChats } = await import('/src/lib/pilotChat.svelte.ts');
      await refreshChats();
    });
    await page.keyboard.press('a');
    await page.locator('.pilot-row').filter({ hasText: 'Atlas planning' }).click();
    const editor = page.getByRole('textbox', { name: 'Message Pilot' });
    await editor.waitFor();
    assert.equal(await editor.evaluate(el => el === document.activeElement), true, 'conversation opens ready to type');
    assert.equal(await editor.getAttribute('data-input-hint'), null);
    const log = page.getByRole('log', { name: 'Pilot messages' });
    const hint = page.locator('.transcript-navigation');
    assert.equal((await hint.innerText()).trim(), 'PgUp/PgDn scroll');
    const top = () => log.evaluate(el => el.scrollTop);
    await log.evaluate(el => { el.scrollTop = 200; });
    await page.waitForTimeout(50);
    const before = await top();
    const pageStep = await log.evaluate(el => el.clientHeight * .85);
    await page.keyboard.press('PageDown');
    assert(Math.abs(await top() - before - pageStep) < 2, 'PageDown scrolls the transcript while composing');
    await page.keyboard.press('PageUp');
    assert(Math.abs(await top() - before) < 2, 'PageUp scrolls back');
    assert.equal(await editor.evaluate(el => el === document.activeElement), true, 'page scrolling preserves composer focus');
    await page.keyboard.type('ijkJK');
    assert.equal(await editor.innerText(), 'ijkJK', 'old navigation keys are ordinary typing');
    assert(Math.abs(await top() - before) < 2, 'typing does not scroll the transcript');
    await editor.evaluate(el => el.blur());
    for (const key of ['j', 'k', 'Shift+j', 'Shift+k']) {
      await page.keyboard.press(key);
      assert(Math.abs(await top() - before) < 2, 'old navigation is unbound outside the composer too');
    }
    await editor.focus();
    await page.keyboard.press('Escape');
    await page.locator('.pilot-panel').waitFor({state:'detached'});
    await page.keyboard.press('a');
    await page.locator('.pilot-row').filter({hasText:'Atlas planning'}).click();
    await editor.waitFor();
    assert.equal(await editor.evaluate(el => el === document.activeElement), true);
    assert.equal(await editor.innerText(), 'ijkJK', 'Escape preserves draft');
    await page.keyboard.press('Shift+Escape');
    await page.locator('.pilot-panel').waitFor({state:'detached'});
    await page.screenshot({ path: '/private/tmp/bigbrain-chat-navigation.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: composer autofocus, PageUp/PageDown, ordinary i/j/k typing, direct Escape, archive while focused, and retained draft');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
