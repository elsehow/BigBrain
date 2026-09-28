// Bounded agent excerpts in the production shell, using invented conversation text.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5246'}/sidebar-workbench.html`);
      await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
      await page.evaluate(async () => {
        const { chat, refreshChats } = await import('/src/lib/pilotChat.svelte.ts');
        await refreshChats();
        const sample = JSON.parse(JSON.stringify(chat.sessions.find(s => s.title === 'Atlas planning')));
        sample.title = 'Review the field research findings and prepare a detailed follow-up for the next planning session';
        sample.live = Array(20).fill('Review the observations and compare the proposed explanations.').join('\n\n');
        sample.notifications = []; sample.revision += 100;
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const u = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (u.pathname === '/api/pilot/chat') return new Response(JSON.stringify({ sessions: [sample] }));
          if (u.pathname === '/api/pilot/chat/session') return new Response(JSON.stringify(sample));
          return original(input, init);
        };
        await refreshChats();
      });
      await page.keyboard.press('j');
      await page.locator('.workspace-menu .agent-row').first().focus();
      const quick = page.getByRole('region', { name: 'Quick look', exact: true });
      await quick.locator('.preview-text').waitFor();
      const geometry = await quick.evaluate(el => {
        const p = el.querySelector('.preview-text'), body = el.querySelector('.agent-preview');
        const style = getComputedStyle(p), rect = p.getBoundingClientRect(), box = body.getBoundingClientRect(), card = el.getBoundingClientRect();
        return { lines: style.webkitLineClamp, textHeight: rect.height, lineHeight: parseFloat(style.lineHeight), bottomPadding: box.bottom - rect.bottom, cardBottom: card.bottom, bodyBottom: box.bottom, x: card.x, right: card.right, scroll: body.scrollHeight > body.clientHeight, clipped: p.scrollHeight > p.clientHeight };
      });
      assert.equal(geometry.lines, '3');
      assert(geometry.textHeight <= geometry.lineHeight * 3 + 1);
      assert(geometry.clipped, 'long text is clamped');
      assert(geometry.bottomPadding >= 11, 'excerpt retains bottom padding');
      assert(geometry.bodyBottom <= geometry.cardBottom + 1, 'body is not cut off by card');
      assert(!geometry.scroll, 'preview does not need scrolling');
      assert(geometry.x >= 0 && geometry.right <= width);
      await page.screenshot({ path: `/tmp/pilot-quick-look-${width}.png` });
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: long agent previews clamp with intact padding at desktop and narrow widths in AppShell');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
