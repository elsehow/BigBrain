// The background graph must hold still while a conversation is open: a worker
// arriving or a session update must not reframe the vault, a hand-set zoom must
// survive both, and deliberate navigation must still move the camera.
// Production shell (sidebar-workbench mounts AppShell), fabricated sessions.
// SIDEBAR_PREVIEW_URL=http://127.0.0.1:5200 node test/support/graphCameraStability.browser.cjs
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
const agent = 'pilot-11111111111111111111111111111111';

(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/sidebar-workbench.html?graphEffects=none`);
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor();
    await page.waitForTimeout(1400);
    const camera = () => canvas.evaluate(c => { const p = c.profilePresentation().camera; return { x: +p.x.toFixed(3), y: +p.y.toFixed(3), zoom: +p.zoom.toFixed(6), manual: p.manual }; });
    const nodeCount = () => canvas.evaluate(c => c.profilePresentation().nodes.length);
    const settle = () => page.waitForTimeout(1500);

    await page.keyboard.press('j'); await settle();
    const opened = await camera();
    assert(await page.locator('.graph-renderer').getAttribute('data-selected'), 'a conversation is open');

    // 1. A session update that moves the session to the end of the client array
    //    (what accept() does) is not new geometry: no rebuild, no camera move.
    const originalStats = await canvas.evaluate(c => { c.originalStats = c.profileStats; return c.profileStats.frames >= 0; });
    assert(originalStats);
    await page.evaluate(async id => {
      const { chat } = await import('/src/lib/pilotChat.svelte.ts');
      const session = chat.sessions.find(s => s.id === id);
      chat.sessions = [...chat.sessions.filter(s => s.id !== id), { ...session, phase: 'working', title: 'Renamed while running', revision: session.revision + 1 }];
    }, agent);
    await page.waitForFunction(id => document.querySelector('.graph-renderer canvas').profilePresentation().nodes.find(n => n.id === id)?.phase === 'working', agent);
    await settle();
    assert(await canvas.evaluate(c => c.originalStats === c.profileStats), 'a session update does not rebuild the renderer');
    assert.deepEqual(await camera(), opened, 'a session update does not move the camera');

    // 2. A worker appearing IS new geometry — the renderer is rebuilt — but the
    //    rebuilt renderer adopts the camera instead of refitting the vault.
    const before = await nodeCount();
    await page.evaluate(async id => {
      const { work } = await import('/src/lib/workSessions.svelte.ts');
      const at = new Date().toISOString();
      work.sessions = [{ id: 'work-11111111111111111111111111111111', title: 'Background worker', provider: 'claude',
        status: 'running', cwd: '/sample/project', created: at, updated: at, revision: 1, pending: false,
        context: { requestKey: 'k', nodes: [], node: null, title: '', text: '', session: null, cwd: '/sample/project' },
        origin: { pilot: id, message: 'm1' },
        worker: { projectId: 'p', operations: [], isolation: 'worktree' } }, ...work.sessions];
    }, agent);
    await page.waitForFunction(count => document.querySelector('.graph-renderer canvas').profilePresentation().nodes.length > count, before);
    const firstFrame = await camera();
    assert.equal(firstFrame.zoom, opened.zoom, 'the rebuild does not snap the zoom on its first frame');
    await settle();
    const adopted = await camera();
    assert.equal(adopted.zoom, opened.zoom, 'the rebuild does not refit the vault');
    assert(Math.hypot(adopted.x - opened.x, adopted.y - opened.y) < 20, `centre held: ${JSON.stringify([opened, adopted])}`);

    // 3. A hand-set zoom survives further background updates.
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .75, box.y + box.height / 2);
    await page.mouse.wheel(0, -600); await settle();
    const held = await camera();
    assert(held.manual, 'the wheel hands the camera to the user');
    assert.notEqual(held.zoom, adopted.zoom, 'the wheel actually zoomed');
    await page.evaluate(async id => {
      const { work } = await import('/src/lib/workSessions.svelte.ts');
      const at = new Date().toISOString();
      work.sessions = [{ ...work.sessions[0], status: 'waiting', updated: at, revision: 2 },
        { ...work.sessions[0], id: 'work-22222222222222222222222222222222', title: 'Second worker', created: at, updated: at }];
      const { chat } = await import('/src/lib/pilotChat.svelte.ts');
      const session = chat.sessions.find(s => s.id === id);
      chat.sessions = [...chat.sessions.filter(s => s.id !== id), { ...session, phase: 'answered', revision: session.revision + 1 }];
    }, agent);
    await settle();
    const survived = await camera();
    assert.equal(survived.zoom, held.zoom, 'background updates do not take a hand-set zoom back');
    assert(survived.manual, 'the hand keeps the camera');

    // 4. Deliberate navigation still moves it: Escape refits the whole vault.
    await page.keyboard.press('Escape'); await settle();
    const refitted = await camera();
    assert.notEqual(refitted.zoom, survived.zoom, 'Escape still reframes the vault');
    assert(!refitted.manual, 'refit returns the camera to the app');

    // 5. Scrolling the transcript does not reach the canvas.
    await page.keyboard.press('j'); await settle();
    const reading = await camera();
    const transcript = page.locator('[role="log"][aria-label="Pilot messages"]').first();
    if (await transcript.count()) {
      const t = await transcript.boundingBox();
      await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
      await page.mouse.wheel(0, 400); await settle();
      assert.deepEqual(await camera(), reading, 'scrolling the conversation leaves the graph alone');
    }

    assert.deepEqual(errors, []);
    console.log('PASS: rebuild adopts the camera, background updates and hand zoom are stable, navigation and refit still move');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
