// Selection-to-paint timing in AppShell, with a controlled cold-session fetch.
const { chromium, webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
 for (const engine of [webkit, chromium]) {
  const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) });
  try {
   for (const cold of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => window.addEventListener('keydown', e => window.agentStart?.(e), true));
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/sidebar-workbench.html${process.env.PROFILE_QUERY || ''}`);
    await page.locator('.lg-wrap canvas').first().waitFor();
    await page.waitForTimeout(1200);
    await page.evaluate(async cold => {
     const { chat, loadChatDetail } = await import('/src/lib/pilotChat.svelte.ts');
     const s = chat.sessions.find(s => s.title === 'Atlas planning');
     if (!s) throw Error('Missing fixture session (restart Vite after state-module edits)');
     if (!cold) await loadChatDetail(s.id);
     else chat.sessions = chat.sessions.map(record => record.id === s.id ? { ...record, detailRevision: undefined, messages: [] } : record);
     const fetch = window.fetch.bind(window);
     let release; const gate = new Promise(resolve => release = resolve);
     window.agentTiming = { cold, requests: 0 };
     window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname === '/api/pilot/chat/session' && url.searchParams.get('id') === s.id) {
       window.agentTiming.requests++;
       if (cold) await gate;
       const response = await fetch(input, init);
       window.agentTiming.response = performance.now();
       return response;
      }
      return fetch(input, init);
     };
     window.agentStart = e => {
      if (e.key !== 'Enter' || !document.querySelector('.workspace-menu .agent-row.current')) return;
      window.agentStart = null;
      const t = window.agentTiming; t.start = performance.now();
      setTimeout(release, 400);
      const read = () => {
       if (!t.panel && document.querySelector('.pilot-panel')) {
        t.panel = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => t.panelPaint = performance.now()));
       }
       if (!t.messages && document.querySelector('.pilot-panel [data-message-id]')) {
        t.messages = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => t.messagesPaint = performance.now()));
       }
       if (!t.messagesPaint) requestAnimationFrame(read);
      }; requestAnimationFrame(read);
     };
    }, cold);
    await page.keyboard.press('j');
    await page.locator('.workspace-menu .agent-row').first().waitFor();
    await page.locator('.workspace-menu .agent-row').filter({ hasText: 'Atlas planning' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.agentTiming.messagesPaint, null, { timeout: 8000 }).catch(async e => {
     console.log(await page.evaluate(async () => ({ timing: window.agentTiming, hash: location.hash, body: document.body.innerText.slice(-1800), chat: (await import('/src/lib/pilotChat.svelte.ts')).chat.sessions.map(s => ({ id: s.id, title: s.title, detail: s.detailRevision, revision: s.revision, messages: s.messages.length })) })));
     console.log(errors); throw e;
    });
    const result = await page.evaluate(() => {
     const t = window.agentTiming, ms = key => t[key] == null ? null : Math.round((t[key] - t.start) * 10) / 10;
     return { cold: t.cold, requests: t.requests, panelMs: ms('panel'), panelPaintMs: ms('panelPaint'), responseMs: ms('response'), messagesPaintMs: ms('messagesPaint') };
    });
    console.log(JSON.stringify({ browser: engine.name(), ...result }));
    if (process.env.PROFILE_ASSERT !== '0') {
     if (cold) assert(result.panelPaintMs < result.responseMs, 'chat paints before the pending session arrives');
     assert.equal(result.requests, cold ? 1 : 0, 'preview and chat share one detail request; warm detail stays cached');
    }
    await page.keyboard.press('Escape');
    await page.locator('.workspace-menu .agent-row').first().waitFor();
    assert.deepEqual(errors, []);
    await page.close();
   }
  } finally { await browser.close(); }
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
