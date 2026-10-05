const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
(async () => {
 const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
 try {
  const context = await browser.newContext(), page = await context.newPage(), other = await context.newPage();
  const url = `${base}/sidebar-workbench.html?vaultScope=1`;
  await Promise.all([page.goto(url), other.goto(url)]);
  const ready = p => p.waitForFunction(async () => (await import('/src/lib/vaultScope.ts')).vaultReady());
  await Promise.all([ready(page), ready(other)]);
  const read = p => p.evaluate(async () => {
   const { swr } = await import('/src/lib/api.ts'); const result = swr.note('memory/index.md');
   return { cached: result.cached?.body, fresh: (await result.fresh).body };
  });
  assert.equal((await read(page)).fresh, 'Invented content from vault A');
  await page.evaluate(async () => {
   const { vaultStorageKey } = await import('/src/lib/vaultScope.ts');
   sessionStorage.setItem(vaultStorageKey('pilot-pending:same-id'), 'pending-A');
   sessionStorage.setItem(vaultStorageKey('draft:same-id'), 'draft-A');
   const { api } = await import('/src/lib/api.ts');
   window.lateResult = api.note('late').then(() => 'escaped', () => 'rejected');
  });
  await page.evaluate(() => localStorage.setItem('fixture-vault', 'B'));
  const switchPage = async p => {
   const loaded = p.waitForEvent('load');
   await p.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    // Let evaluate return before the deliberate vault reload destroys its context.
    setTimeout(() => void api.vault().catch(() => {}), 0);
   });
   await loaded; await ready(p);
  };
  await Promise.all([switchPage(page), switchPage(other)]);
  for (const p of [page, other]) {
   const result = await read(p); assert.notEqual(result.cached, 'Invented content from vault A');
   assert.equal(result.fresh, 'Invented content from vault B');
  }
  assert.equal(await page.evaluate(async () => sessionStorage.getItem((await import('/src/lib/vaultScope.ts')).vaultStorageKey('pilot-pending:same-id'))), null);
  await page.reload(); await ready(page); assert.equal((await read(page)).fresh, 'Invented content from vault B');
  await page.evaluate(() => localStorage.setItem('fixture-vault', 'A'));
  await switchPage(page);
  assert.equal((await read(page)).fresh, 'Invented content from vault A');
  assert.equal(await page.evaluate(async () => sessionStorage.getItem((await import('/src/lib/vaultScope.ts')).vaultStorageKey('pilot-pending:same-id'))), 'pending-A');
  await page.evaluate(async () => { const { clearSwrCache } = await import('/src/lib/api.ts'); clearSwrCache(); });
  assert.equal(await page.evaluate(async () => sessionStorage.getItem((await import('/src/lib/vaultScope.ts')).vaultStorageKey('draft:same-id'))), 'draft-A');
  await page.evaluate(() => { localStorage.setItem('fixture-vault', 'B'); localStorage.setItem('fixture-vault-failure', 'B'); });
  await switchPage(page);
  const failed = await page.evaluate(async () => { const { swr, clearSwrCache } = await import('/src/lib/api.ts'); clearSwrCache(); const value = swr.note('memory/index.md'); return { cached: value.cached, error: await value.fresh.then(() => false, () => true) }; });
  assert.equal(failed.cached, undefined); assert.equal(failed.error, true);
  console.log('production base and Field: A → B → A, shared-origin tabs, reload, pending IDs, draft preservation, and failed B reads passed.');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
