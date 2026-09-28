const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/sidebar-workbench.html?graphEffects=none`);
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor(); await page.waitForTimeout(1200);
    const labels = await canvas.evaluate(c => c.profilePresentation().labels);
    const label = labels.find(b => b.id === 'memory/project.md'); assert(label, 'home has memory labels');
    await page.mouse.move(label.left + 5, label.top + 10); await page.waitForTimeout(800);
    await page.mouse.click(label.left + 5, label.top + 10);
    await page.waitForFunction(id => document.querySelector('.graph-renderer').dataset.selected === id, label.id);
    await page.waitForTimeout(1200);
    assert((await canvas.evaluate(c => c.profilePresentation().labels)).some(b => b.id === label.id), 'clicked label retains its selected title');
    const result = await page.evaluate(async () => {
      const { GraphRenderer } = await import('/src/lib/graph/renderer.ts');
      const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px'; document.body.append(c);
      const graph = { nodes: [0, 1, 2].map(i => ({ id: `label-${i}`, title: `A readable long title ${i}`, group: 'memory', degree: 12, x: i * 100, y: 0 })), edges: [] };
      const r = new GraphRenderer(c, graph); let now = performance.now() + 1200; r.draw(now);
      // Use the public drag path to crowd three labels at one screen position.
      for (const node of r.getPresentation(now).nodes) {
        r.beginNodeDrag(node.id, node, now); r.dragNode({ x: 300, y: 200 }); r.endNodeDrag(now); r.draw(now += 1200);
      }
      r.select('label-0', now, true); r.hover('label-1', now); r.draw(now += 1200);
      const scene = r.getPresentation(now), uploads = r.stats.labelUploads;
      const plates = [];
      for (const theme of ['default', 'dusk']) {
        document.documentElement.dataset.theme = theme; r.setPalette(); r.draw(now += 1200);
        const box = r.getPresentation(now).labels[0], gl = c.getContext('webgl2'), pixel = new Uint8Array(4);
        gl.readPixels(Math.round((box.left + 3) * devicePixelRatio), c.height - Math.round((box.top + 10) * devicePixelRatio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        plates.push([...pixel]);
      }
      r.draw(now + 16); r.draw(now + 32);
      const noRasterization = r.stats.labelUploads === uploads;
      const glError = c.getContext('webgl2').getError(); r.dispose(); c.remove();
      return { boxes: scene.labels, plates, noRasterization, glError };
    });
    assert(result.boxes.some(b => b.id === 'label-0'), 'selected title wins crowded placement');
    for (const [i, a] of result.boxes.entries()) for (const b of result.boxes.slice(i + 1))
      assert(!(a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height), 'visible label plates do not overlap');
    assert(result.plates.every(p => p[3] > 100), 'actual GPU plates render behind text');
    assert(result.plates[0][0] > 150 && result.plates[1][0] < 60, 'plates follow light and dark ground');
    assert(result.noRasterization, 'camera/status frames reuse cached text'); assert.equal(result.glError, 0);
    assert.deepEqual(errors, []);
    console.log('PASS: production-shell memory label click, prioritized collision placement, GPU light/dark backplates and cached text');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
