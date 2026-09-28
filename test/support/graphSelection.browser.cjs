// Real shell and pointer events, including macOS Ctrl-click without pointerdown.
const { webkit, chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
 for (const engine of [webkit, chromium]) {
  const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) });
  try {
   const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
   const errors = []; page.on('pageerror', e => errors.push(e.message));
   await page.route('**/api/**', r => r.abort());
   await page.goto(`${base}/${process.env.GRAPH_ENTRY || 'sidebar-workbench.html'}`);
   const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor(); await page.waitForTimeout(1600);
   const scene = () => canvas.evaluate(c => c.profilePresentation());
   const point = async id => (await scene()).nodes.find(n => n.id === id);
   const click = async (id, shift = false) => {
    let p = await point(id); await page.mouse.move(p.x, p.y); await page.waitForTimeout(800); p = await point(id);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(p.x, p.y);
    if (shift) await page.keyboard.up('Shift');
    await page.mouse.move(1439, 999); await page.waitForTimeout(850);
   };
   const candidates = state => state.nodes.filter(n => n.group === 'memory' && n.opacity > .5 && n.x > 590 && n.x < 1300 && n.y > 100 && n.y < 860);
   const first = candidates(await scene())[0]; assert(first, 'fixture has a visible memory');
   await click(first.id);
   const route = await page.evaluate(() => location.hash);
   const second = candidates(await scene()).find(n => n.id !== first.id); assert(second, 'second visible memory');
   await click(second.id, true);
   const combined = await scene();
   assert.deepEqual(combined.view.selected.sort(), [first.id, second.id].sort());
   assert.equal(await page.evaluate(() => location.hash), route, 'Shift-click retains the open note');
   for (const id of [first.id, second.id]) {
    const root = combined.nodes.find(n => n.id === id); assert(root.selected && root.inkOpacity > .99);
    const links = combined.edges.filter(e => e.source === id || e.target === id);
    assert(links.some(e => e.ink > .9), 'both selected neighborhoods retain their spokes');
   }
   const p = await point(second.id);
   for (const type of ['mousedown', 'contextmenu', 'pointerup', 'mouseup']) await canvas.dispatchEvent(type, {
    button: 2, buttons: type.endsWith('up') ? 0 : 1, ctrlKey: true, clientX: p.x, clientY: p.y,
   });
   await page.waitForTimeout(850);
   const excluded = await scene();
   assert.deepEqual(excluded.view, { selected: [first.id], excluded: [second.id] });
   assert.equal(excluded.nodes.find(n => n.id === second.id).opacity, 0);
   assert(excluded.edges.filter(e => e.source === second.id || e.target === second.id).every(e => e.activity === 0));
   assert.equal(await page.evaluate(() => location.hash), route, 'excluding does not navigate');
   await page.keyboard.press('Escape'); await page.waitForTimeout(1200);
   const home = await scene(); assert.deepEqual(home.view, { selected: [], excluded: [] });
   assert(home.nodes.find(n => n.id === second.id).visible, 'Escape restores exclusions');
   assert.equal(await page.locator('.lg-wrap canvas').count(), 1);
   assert.equal(home.effects, 'all', 'production defaults include the approved effects');
   await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(1200);
   const frames = await canvas.evaluate(c => c.profileStats.frames); await page.waitForTimeout(250);
   assert.equal(await canvas.evaluate(c => c.profileStats.frames), frames, 'reduced-motion production graph sleeps');
   assert.deepEqual(errors, []);
   console.log(`PASS ${engine.name()}: production default, Shift union, macOS Ctrl exclusion, stable document, Escape, one canvas, reduced motion`);
  } finally { await browser.close(); }
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
