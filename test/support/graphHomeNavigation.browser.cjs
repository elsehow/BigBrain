const { webkit, chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
 for (const engine of [webkit, chromium]) {
  const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) });
  try {
   for (const viewport of [{ width: 1440, height: 1000 }, { width: 3790, height: 1183 }, { width: 720, height: 900 }]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/${process.env.GRAPH_ENTRY || 'sidebar-workbench.html'}`);
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor(); await page.waitForTimeout(1200);
    const scene = () => canvas.evaluate(c => c.profilePresentation());
    const home = await scene();
    for (const key of ['j', 'j', 'j', 'k']) {
     const before = await scene(); await page.keyboard.press(key);
     await page.waitForTimeout(100); const moving = await scene();
     await page.waitForTimeout(1300); const settled = await scene();
     const selected = await page.locator('.graph-renderer').getAttribute('data-selected');
     const point = settled.nodes.find(n => n.id === selected);
     assert(Math.hypot(settled.camera.x - before.camera.x, settled.camera.y - before.camera.y) > 1, `each ${key} step pans`);
     assert(Math.hypot(settled.camera.x - moving.camera.x, settled.camera.y - moving.camera.y) > .1, 'the pan glides rather than snapping');
     assert(Math.abs(settled.camera.zoom - home.camera.zoom) < .001, 'keyboard panning preserves the home scale');
     const clear = await canvas.evaluate((c, point) => document.elementFromPoint(point.x, point.y) === c, point);
     assert(clear, 'selected node stays outside menu and text-panel hit areas');
     const preview = await page.getByRole('region', { name: 'Quick look', exact: true }).boundingBox();
     assert(point.y < preview.y - 30, 'quick-look text leaves room for the selected node');
    }
    const surfaces = await page.evaluate(() => {
     const read = el => { const s = getComputedStyle(el); const c = document.createElement('canvas'), ctx = c.getContext('2d'); ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1); return { alpha: ctx.getImageData(0, 0, 1, 1).data[3], blur: s.backdropFilter || s.webkitBackdropFilter }; };
     return [read(document.querySelector('.workspace-menu')), read(document.querySelector('.sidebar-quick .sheet'))];
    });
    assert.deepEqual(surfaces[0], surfaces[1]); assert(surfaces[0].alpha > 160 && surfaces[0].alpha < 230);
    await page.keyboard.press('Escape'); await page.waitForTimeout(1500);
    const restored = await scene();
    assert.deepEqual(restored.view, { selected: [], excluded: [] });
    for (const key of ['x', 'y', 'zoom']) assert(Math.abs(restored.camera[key] - home.camera[key]) < .001, `Escape restores ${key}`);
    if (viewport.width === 1440) await page.screenshot({ path: `/tmp/graph-home-${engine.name()}.png` });
    assert.deepEqual(errors, []); await page.close();
    console.log(`PASS ${engine.name()} ${viewport.width}x${viewport.height}: keyboard glide, unchanged scale, unobscured focus, shared glass, Escape home`);
   }
  } finally { await browser.close(); }
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
