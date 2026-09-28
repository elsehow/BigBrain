/** Focus preserves the home silhouette; depth shading is checked on GPU pixels. */
const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/sidebar-workbench.html?graphEffects=none`);
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor(); await page.waitForTimeout(1500);
    const home = await canvas.evaluate(c => c.profilePresentation());
    await page.keyboard.press('j'); await page.waitForTimeout(350);
    const selected = await page.locator('.graph-renderer').getAttribute('data-selected');
    const focus = await canvas.evaluate(c => c.profilePresentation());
    const assertSettled = async early => {
      await page.waitForTimeout(500);
      const late = await canvas.evaluate(c => c.profilePresentation());
      await page.waitForTimeout(100);
      const resting = await canvas.evaluate(c => c.profilePresentation());
      for (let i = 0; i < late.nodes.length; i++)
        assert(Math.abs(late.nodes[i].height - resting.nodes[i].height) < .001, 'focus tail settles and stays at rest');
      for (let i = 0; i < early.nodes.length; i++) for (const key of ['height', 'inkOpacity'])
        assert(Math.abs(early.nodes[i][key] - late.nodes[i][key]) < (key === 'inkOpacity' ? .03 : 3), 'j/k arrives promptly, leaving only a small settling tail at 350ms');
    };
    await assertSettled(focus);
    await page.keyboard.press('j'); await page.waitForTimeout(120);
    await page.keyboard.press('k'); await page.waitForTimeout(350);
    assert.equal(await page.locator('.graph-renderer').getAttribute('data-selected'), selected);
    await assertSettled(await canvas.evaluate(c => c.profilePresentation()));
    const before = home.nodes.find(n => n.id === selected), after = focus.nodes.find(n => n.id === selected);
    assert(before && after); assert.equal(after.height, before.height); assert.equal(after.radius, before.radius);
    assert.equal(focus.camera.zoom, home.camera.zoom, 'AppShell selection preserves home zoom');
    assert(Math.hypot(after.x - before.x, after.y - before.y) > 1, 'home keyboard preview pans while preserving depth and scale');
    const result = await page.evaluate(async () => {
      const { GraphRenderer } = await import('/src/lib/graph/renderer.ts');
      const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;inset:0;width:1200px;height:900px'; document.body.append(c);
      const graph = { nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, title: '', group: 'source', degree: 10, x: (i % 4 - 1.5) * 150, y: (Math.floor(i / 4) - .5) * 150 })),
        edges: Array.from({ length: 7 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` })) };
      const r = new GraphRenderer(c, graph); let t = 10000; r.draw(t);
      const scene = () => r.getPresentation(t);
      const pixel = n => { const gl = c.getContext('webgl2'), p = new Uint8Array(4); gl.readPixels(Math.round(n.x * 2), c.height - Math.round(n.y * 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return p[3]; };
      const home = scene(), homeAlpha = pixel(home.nodes[2]);
      r.select('n0', t); r.draw(t); r.draw(t += 1000); const selected = scene(), selectedAlpha = pixel(selected.nodes[2]);
      r.refit(t); r.draw(t); r.draw(t += 1000);
      r.zoomAt({ x: 600, y: 450 }, 1.1, t); r.draw(t += 1200); const zoomed = scene();
      r.select('n1', t); r.draw(t); r.draw(t += 1000); const zoomSelected = scene();
      r.select('n0', t); r.draw(t); r.draw(t += 1000);
      r.hover('n4', t); r.draw(t += 800); const neighborhood = scene();
      const neighborPixels = [3, 4, 5].map(i => pixel(neighborhood.nodes[i]));
      r.refit(t); r.draw(t); r.draw(t += 1000); r.hover('n0', t); r.draw(t += 250);
      const moving = scene(); r.draw(t += .01); const movingNext = scene();
      r.hover('n1', t); r.draw(t); const changed = scene(), uploads = { ...r.stats };
      r.draw(t += .01); const changedNext = scene(); r.draw(t += 800);
      const reuse = r.stats.uploads === uploads.uploads && r.stats.inkUploads === uploads.inkUploads;
      const error = c.getContext('webgl2').getError(); r.dispose(); c.getContext('webgl2').getExtension('WEBGL_lose_context')?.loseContext(); c.remove();
      return { neighborhood, neighborPixels, home, selected, homeAlpha, selectedAlpha, zoomed, zoomSelected, moving, movingNext, changed, changedNext, reuse, error };
    });
    assert.deepEqual(result.selected.camera, result.home.camera, 'visible focus does not recenter');
    for (const i of [0, 1]) for (const key of ['x', 'y', 'height', 'radius'])
      assert.equal(result.selected.nodes[i][key], result.home.nodes[i][key], 'focus and direct neighbors preserve home geometry');
    for (let i = 2; i < 8; i++) {
      assert.equal(result.selected.nodes[i].height, result.home.nodes[i].height - 60);
      assert(result.selected.nodes[i].inkOpacity <= result.home.nodes[i].inkOpacity, 'periphery gets quieter, not darker');
    }
    assert(result.homeAlpha > 20 && result.selectedAlpha > 5 && result.selectedAlpha < result.homeAlpha * .5, `actual background pixels convey depth without vanishing: ${result.homeAlpha} -> ${result.selectedAlpha}`);
    assert.equal(result.zoomed.camera.zoom, result.zoomSelected.camera.zoom, 'focus preserves manual zoom');
    const vBefore = (result.movingNext.nodes[2].height - result.moving.nodes[2].height) / .01;
    const vAfter = (result.changedNext.nodes[2].height - result.changed.nodes[2].height) / .01;
    assert(Math.abs(vBefore) > .01 && Math.abs(vBefore - vAfter) < .0001, 'background velocity survives a hover interruption');
    assert(result.neighborPixels.every(alpha => alpha > 245), 'hover and direct neighbors have full foreground ink in actual GPU pixels');
    for (const edge of result.neighborhood.edges.filter(e => e.source === 'n4' || e.target === 'n4'))
      assert.equal(edge.ink, 1, 'hover spokes remain emphasized outside the selected neighborhood');
    assert(result.neighborhood.nodes[2].inkOpacity < .5, 'second-degree neighbors stay quiet');
    assert(result.reuse, 'motion reuses uploaded state and ink'); assert.equal(result.error, 0);
    console.log('PASS: AppShell home-to-focus continuity, retained zoom, first-degree geometry, GPU depth shading, interrupted velocity and buffer reuse');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
