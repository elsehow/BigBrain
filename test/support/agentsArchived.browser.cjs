// Production AppShell, synthetic roster; no vault or agent process.
// SIDEBAR_PREVIEW_URL=http://127.0.0.1:5200 node test/support/agentsArchived.browser.cjs
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200'}/sidebar-workbench.html`);
    await page.getByRole('button', { name: 'Agents', exact: true }).focus();
    await page.keyboard.press('a');
    await page.locator('.pilot-row').first().waitFor();
    await page.evaluate(async () => {
      const { chat, refreshChats } = await import('/src/lib/pilotChat.svelte.ts');
      // Drain the shell's initial single-flight refresh before replacing its transport.
      await refreshChats();
      const sample = JSON.parse(JSON.stringify(chat.sessions.find(s => !s.deactivatedAt)));
      // A changed public record must advance its revision, including summaries.
      sample.revision = Math.max(...chat.sessions.map(s => s.revision)) + 1;
      sample.messages ??= [];
      sample.inputs ??= [];
      sample.spoken ??= [];
      window.archiveFixtureSessions = Array.from({ length: 4 }, (_, i) => ({
        ...sample, id: 'pilot-' + String(i + 1).repeat(32), title: 'Agent ' + i,
        created: new Date(2026, 0, 4 - i).toISOString(),
        deactivatedAt: i % 2 ? new Date().toISOString() : undefined,
      }));
      // Polling and detail loads must use the same roster as the scenario.
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const url = new URL(String(input), location.href);
        const sessions = window.archiveFixtureSessions;
        if (url.pathname === '/api/pilot/chat') return new Response(JSON.stringify({sessions}));
        if (url.pathname === '/api/pilot/chat/session') return new Response(JSON.stringify(sessions.find(s => s.id === url.searchParams.get('id'))));
        return original(input, init);
      };
      await refreshChats();
    });
    const filter = page.getByRole('button', { name: 'Show archived', exact: true });
    const rows = page.locator('.pilot-row');
    const titles = () => rows.locator('.row-heading strong').allTextContents();
    const count = () => page.locator('.list-heading > strong > span').innerText();
    await page.waitForFunction(() => document.querySelector('.list-heading > strong > span')?.textContent === '2');
    assert.equal(await filter.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await titles(), ['Agent 0', 'Agent 2']);
    await rows.first().focus();
    await page.keyboard.press('j');
    assert.equal(await page.locator('.pilot-row.selected strong').innerText(), 'Agent 2');
    await page.keyboard.press('k');
    assert.equal(await page.locator('.pilot-row.selected strong').innerText(), 'Agent 0');
    await filter.focus();
    await page.keyboard.press('Enter');
    assert.equal(await filter.getAttribute('aria-pressed'), 'true');
    assert.equal(await count(), '4');
    assert.deepEqual(await titles(), ['Agent 0', 'Agent 1', 'Agent 2', 'Agent 3']);
    assert.equal(await page.locator('.pilot-panel').count(), 0, 'Enter on the filter does not open the selected agent');
    await rows.first().focus();
    await page.keyboard.press('End');
    assert.equal(await page.locator('.pilot-row.selected strong').innerText(), 'Agent 3');
    await filter.focus();
    await page.keyboard.press('Space');
    assert.equal(await filter.getAttribute('aria-pressed'), 'false');
    assert.equal(await count(), '2');
    assert.equal(await page.locator('.pilot-row.selected').count(), 0, 'hidden selection is cleared');
    assert.equal(await page.evaluate(async () => (await import('/src/lib/stage.svelte.ts')).stage.pilotPreviewId), null);
    // Resume list navigation from a cleared selection, without moving focus off the list.
    await filter.evaluate(el => el.blur());
    await page.keyboard.press('j');
    assert.equal(await page.locator('.pilot-row.selected strong').innerText(), 'Agent 0');
    await page.keyboard.press('End');
    assert.equal(await page.locator('.pilot-row.selected strong').innerText(), 'Agent 2');
    await page.keyboard.press('Home');
    assert.equal(await page.locator('.pilot-row.selected strong').innerText(), 'Agent 0');
    await page.screenshot({ path: '/tmp/agents-archived-toggle.png' });
    // An all-archived roster can be empty and then revealed again.
    await page.evaluate(async () => {
      const { refreshChats } = await import('/src/lib/pilotChat.svelte.ts');
      window.archiveFixtureSessions = window.archiveFixtureSessions.map(s => ({ ...s, revision:s.revision + 1, deactivatedAt: new Date().toISOString() }));
      await refreshChats();
    });
    await page.locator('.pilots-pane .empty').waitFor();
    assert.equal(await count(), '0');
    await filter.evaluate(el => el.blur());
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.pilot-panel').count(), 0);
    await filter.click();
    assert.equal(await count(), '4');
    await rows.first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.pilot-panel').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: archived default, toggle, count, keyboard, selection, empty roster, and opening history in AppShell');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
