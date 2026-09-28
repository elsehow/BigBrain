// Production AppShell with fabricated, allowlisted action observations.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
 try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200'}/sidebar-workbench.html?scenario=resume-after-cancel`);
  await page.locator('.pilot-panel').waitFor();
  await page.evaluate(() => {
   const fetch = window.fetch; window.actionWrites = 0; window.actionReads = 0;
   window.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/pilot/chat/actions')) {
     if (init?.method && init.method !== 'GET') window.actionWrites++;
     window.actionReads++;
     if (url.includes('cursor=')) return Response.json({ complete: true, receipts: [{ id: 'older', operation: 'historical', status: 'uncertain' }] });
     return Response.json({ complete: false, issues: [{ kind: 'receipt', count: 1 }], receipts: [
      { id: 'confirmed', operation: 'launch_agent', status: 'completed', created: '2026-09-01T00:00:00Z', observations: [] },
      { id: 'uncertain-after-restart', operation: 'drop', status: 'uncertain', observations: [] },
      { id: 'revoked', operation: 'message_agent', status: 'failed', observations: [] },
      { id: 'pending', operation: 'launch_agent', status: 'prepared', observations: [] },
      { id: 'partial', operation: 'source_set_unread', status: 'completed', observations: [{ kind: 'read-state', confirmed: true, unread: false }, { kind: 'read-state', confirmed: false }] },
     ], nextCursor: url.includes('cursor=') ? undefined : 'fabricated-page' });
    }
    return fetch(input, init);
   };
  });
  const entry = page.getByRole('button', { name: 'Action history', exact: true });
  for (const width of [390, 1280]) {
   await page.setViewportSize({ width, height: 844 });
   const boxes = await page.evaluate(() => {
    const header = document.querySelector('.pilot-panel > header');
    const history = [...header.querySelectorAll('button')].find(b => b.textContent === 'Action history');
    const model = header.querySelector('.model-command');
    return [history, model].map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
   });
   const [history, model] = boxes;
   assert(history.right <= model.left || model.right <= history.left || history.bottom <= model.top || model.bottom <= history.top, 'history and model controls must not overlap');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await entry.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Conversation actions' }); await dialog.waitFor();
  for (const text of ['Outcome unknown', 'Partially confirmed', 'Not dispatched', 'Not started', 'Item 1: read confirmed', 'Item 2: not confirmed']) await dialog.getByText(text, { exact: true }).waitFor();
  await dialog.getByRole('alert').filter({ hasText: 'unreadable' }).waitFor();
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'narrow dialog has no horizontal overflow');
  await dialog.getByRole('button', { name: 'Refresh history' }).click();
  await page.waitForFunction(() => window.actionReads === 2);
  await dialog.getByRole('button', { name: 'Older actions' }).click();
  await dialog.getByText('Earlier action', { exact: false }).waitFor();
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await entry.evaluate(el => document.activeElement === el), true, 'Escape restores entry focus');
  await page.keyboard.press('Enter'); await dialog.waitFor();
  await page.waitForFunction(() => window.actionReads === 4);
  await dialog.getByText('Outcome unknown', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.actionWrites), 0, 'opening, refresh and reconnect do not dispatch effects');
  await page.screenshot({ path: '/tmp/action-history-narrow.png' });
  // A new vault hides the old document immediately; its action UI also resets.
  const loaded = page.waitForEvent('load');
  await page.evaluate(async () => { const { observeVault } = await import('/src/lib/vaultScope.ts'); setTimeout(() => observeVault('fabricated-other-vault'), 0); });
  await loaded;
  assert.equal(await page.getByRole('dialog').count(), 0, 'the new vault document does not retain the prior action history');
  assert.deepEqual(errors, []);
  console.log('PASS: contextual action inspection, partial/revoked/unknown/damaged states, keyboard, narrow layout, non-replay and vault reset');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
