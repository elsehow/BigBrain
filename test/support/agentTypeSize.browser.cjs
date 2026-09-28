const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [1920, 1440, 1200, 600, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(process.env.WORKBENCH_URL || 'http://127.0.0.1:5219/sidebar-workbench.html');
      await page.locator('.lg-wrap').waitFor();
      // Keep the real shell and chat renderer; enrich only the sample response.
      await page.evaluate(async () => {
        const fetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await fetch(...args);
          if (new URL(String(args[0]), location.href).pathname !== '/api/pilot/chat') return response;
          const data = await response.json();
          for (const session of data.sessions) { session.revision += 100; for (const message of session.messages) {
            if (message.role === 'assistant') message.text = '## Heading\n\nBody text with **emphasis**.\n\n- List item';
          }
          }
          return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
        };
        const { refreshChats } = await import("/src/lib/pilotChat.svelte.ts");
        await refreshChats();
      });
      await page.keyboard.press('a');
      await page.locator('.pilot-row').filter({ hasText: 'Atlas planning' }).click();
      await page.locator('.message h2').waitFor();
      const typography = () => page.evaluate(() => Object.fromEntries(
        ['.transcript', '.message h2', '.message p', '.message li', '.user-text', '.editor'].map(selector => {
          const style = getComputedStyle(document.querySelector(selector));
          return [selector, { size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight }];
        })
      ));
      const collapsed = await typography();
      assert.equal(collapsed['.transcript'].size, '18px');
      assert.equal(collapsed['.message h2'].size, '22px');
      assert.deepEqual(collapsed['.user-text'], collapsed['.message p'], 'your message and the agent reply use the same typography');
      await page.getByRole('button', { name: 'Expand to full width', exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.sidebarExpanded === 'true');
      assert.deepEqual(await typography(), collapsed, `expanding at ${width}px must preserve typography`);
      const geometry = await page.evaluate(() => {
        const rect = selector => {
          const { x, right, width } = document.querySelector(selector).getBoundingClientRect();
          return { x, right, width };
        };
        return { panel: rect('.pilot-panel'), text: rect('.reading-column'),
          title: rect('.pilot-panel header > strong'), editor: rect('.editor'),
          send: rect('.composer-actions') };
      });
      const expectedWidth = Math.min(geometry.panel.width - 80, Math.max(672, Math.min(geometry.panel.width * .6, 960)));
      assert(Math.abs(geometry.text.width - expectedWidth) < 2, `responsive reading width at ${width}px`);
      assert(Math.abs(geometry.title.x - geometry.text.x) < 1, 'title aligns with transcript');
      assert(Math.abs(geometry.editor.x - geometry.text.x) < 1, 'composer aligns with transcript');
      assert(Math.abs(geometry.send.right - geometry.text.right) < 1, 'send aligns with transcript');
      assert(geometry.text.x >= 0 && geometry.text.right <= width, 'column fits the viewport');
      await page.getByRole('button', { name: 'Collapse to sidebar', exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.sidebarExpanded === 'false');
      assert.deepEqual(await typography(), collapsed);
      await page.keyboard.press('Alt+l');
      await page.waitForFunction(() => document.documentElement.dataset.sidebarExpanded === 'true');
      assert.deepEqual(await typography(), collapsed, 'keyboard expansion must preserve typography');
      await page.keyboard.press('Alt+h');
      await page.waitForFunction(() => document.documentElement.dataset.sidebarExpanded === 'false');
      assert.deepEqual(await typography(), collapsed);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: production shell agent expansion preserves body, headings, list, user and composer typography at desktop and narrow widths');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
