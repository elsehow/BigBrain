/** Production shell with fabricated sessions; no real vault or agent calls. */
const { webkit, chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:5200';
(async () => {
  for (const engine of [webkit, chromium]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) });
    try {
      for (const width of [1440, 720]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.route('**/api/**', r => r.abort());
        await page.goto(`${base}/sidebar-workbench.html?connected-agent&pilot-status`);
        await page.locator('.graph-renderer canvas').waitFor();
        await page.evaluate(async () => {
          const url = performance.getEntriesByType('resource').find(e => e.name.includes('/src/lib/pilotChat.svelte.ts')).name;
          const chat = await import(url); await chat.refreshChats();
          chat.openChat('pilot-11111111111111111111111111111111');
        });
        const status = page.getByRole('status', { name: 'Connected agent activity' });
        await status.getByRole('button', { name: /Atlas implementation · Working/ }).waitFor();
        const error = page.getByRole('alert').filter({ hasText: 'The model ended its turn without a reply.' });
        await error.waitFor();
        assert.equal(await page.getByText('Pilot completed without an answer.', { exact: true }).count(), 0);
        const column = await page.locator('.reading-column').boundingBox();
        const errorBox = await error.boundingBox();
        const statusBox = await status.boundingBox();
        assert(Math.abs(column.x - errorBox.x) < 1, 'error aligns with chat');
        assert(Math.abs(column.x - statusBox.x) < 1, 'agent activity aligns with chat');
        await page.locator('.transcript').evaluate(el => { el.scrollTop = 0; });
        const composer = await page.locator('.mention-composer').boundingBox();
        assert(statusBox.y > 0 && statusBox.y + statusBox.height <= composer.y, 'agent activity remains visible above composer while reading history');
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('workbench-agent-status', { detail: 'idle' })));
        await status.getByRole('button', { name: /Turn finished/ }).waitFor();
        await page.screenshot({ path: `/tmp/pilot-status-${engine.name()}-${width}.png` });
        await status.getByRole('button').click();
        await page.waitForFunction(() => location.hash.includes('work-aaaaaaaa'));
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${engine.name()} ${width}: aligned error, persistent agent activity, live completion, open agent`);
      }
    } finally { await browser.close(); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
