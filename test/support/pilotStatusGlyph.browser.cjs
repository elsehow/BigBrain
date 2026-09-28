// Production AppShell (sidebar-workbench), synthetic roster; no vault or agent
// process. The complaint this covers was visual: at the sidebar's 28px glyph an
// interrupted conversation was indistinguishable from a draft. So MEASURE the
// mark as rendered, and check that the row also says the word.
// SIDEBAR_PREVIEW_URL=http://127.0.0.1:5200 node test/support/pilotStatusGlyph.browser.cjs
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
      const revision = Math.max(...chat.sessions.map(s => s.revision)) + 1;
      const at = new Date(2026, 0, 2).toISOString();
      const base = (id, title, phase, extra) => ({
        ...sample, id: 'pilot-' + String(id).repeat(32), title, phase, revision,
        created: new Date(2026, 0, id).toISOString(), deactivatedAt: undefined,
        draft: '', draftImages: [], notifications: [], inputs: [], pendingInputs: [], spoken: [],
        messages: [{ id: 'm1', role: 'user', text: 'Please look into the badges.', at }],
        messageCount: 1, hasHistory: true, ...extra,
      });
      window.statusFixtureSessions = [
        // A real draft: nothing sent, so it keeps an empty transcript.
        base(1, 'Draft row', 'draft', { draft: 'Half-written question', messages: [], messageCount: 0, hasHistory: false }),
        base(2, 'Stopped row', 'interrupted'),
        base(3, 'Errored row', 'failed'),
        base(4, 'Finished row', 'answered'),
      ];
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const url = new URL(String(input), location.href);
        const sessions = window.statusFixtureSessions;
        if (url.pathname === '/api/pilot/chat') return new Response(JSON.stringify({ sessions }));
        if (url.pathname === '/api/pilot/chat/session') return new Response(JSON.stringify(sessions.find(s => s.id === url.searchParams.get('id'))));
        return original(input, init);
      };
      await refreshChats();
    });
    // Rows are ordered by activity, so address them by identity, not position.
    const row = id => page.locator(`.pilot-row[data-pilot="pilot-${String(id).repeat(32)}"]`);
    await page.waitForFunction(() => document.querySelectorAll('.pilot-row').length === 4);

    // 1. Every row names its status; an unfinished turn is never "Ready".
    const name = async id => row(id).getAttribute('aria-label');
    assert.match(await name(1), /^Half-written question…, .*, Draft$/);
    assert.match(await name(2), /^Stopped row, .*, Interrupted$/);
    assert.match(await name(3), /^Errored row, .*, Needs attention$/);
    assert.match(await name(4), /^Finished row, .*, Ready$/);
    for (const id of [1, 2, 3]) assert.doesNotMatch(await name(id), /Ready$/);

    // 2. The marks differ in shape at the size the sidebar actually draws.
    const glyph = id => row(id).locator('.identity-glyph');
    const size = await glyph(1).evaluate(el => el.getBoundingClientRect().width);
    assert.equal(size, 28, 'sidebar rows draw the 28px glyph');
    const markBox = async id => {
      const box = await glyph(id).locator('path.caret, path.status-mark').boundingBox();
      assert.ok(box, `row ${id} draws a status mark`);
      return box;
    };
    const [draft, interrupted, failed] = [await markBox(1), await markBox(2), await markBox(3)];
    // Stroke-bounding boxes: a 1.25px stroke plus the mark's own extent.
    assert.ok(draft.height - draft.width > 2, `draft reads as an upright stroke: ${JSON.stringify(draft)}`);
    assert.ok(interrupted.width - interrupted.height > 2, `interrupted reads as a crossbar: ${JSON.stringify(interrupted)}`);
    assert.ok(Math.min(failed.width, failed.height) > 2.5 && Math.abs(failed.width - failed.height) < 2,
      `failed reads as a cross: ${JSON.stringify(failed)}`);
    // The settled row is a filled triangle with no mark at all.
    assert.equal(await glyph(4).locator('path.caret, path.status-mark').count(), 0);
    assert.equal(await glyph(4).locator('path.pilot-triangle.hollow').count(), 0);
    for (const id of [1, 2, 3]) assert.equal(await glyph(id).locator('path.pilot-triangle.hollow').count(), 1);
    await page.screenshot({ path: `${process.env.CI_BROWSER_ARTIFACTS || '.'}/pilot-status-glyphs.png`, animations: 'disabled' });

    // 3. Hovering the glyph explains the mark in words.
    await glyph(2).hover();
    await page.getByText('Interrupted — the turn stopped before it finished', { exact: true }).waitFor();

    assert.deepEqual(errors, []);
    console.log('PASS distinct draft/interrupted/failed marks at 28px, named rows, explained tooltip');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
