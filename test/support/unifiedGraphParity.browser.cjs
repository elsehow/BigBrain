/** Always check drawn GPU pixels. Optionally compare home geometry against a
 * frozen pre-promotion preview via PROFILE_REFERENCE_URL (port 53491). */
const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
const reference = process.env.PROFILE_REFERENCE_URL;
const graph = process.env.PROFILE_GRAPH_FILE ? JSON.parse(fs.readFileSync(process.env.PROFILE_GRAPH_FILE, 'utf8')) : {
  nodes: Array.from({ length: 320 }, (_, i) => ({ id: `sources/parity-${i}.md`, path: `sources/parity-${i}.md`, title: `Parity ${i}`, group: i < 3 ? 'memory' : 'source', degree: i < 3 ? 35 : 3, x: Math.cos(i * 2.4) * Math.sqrt(i + 1) * 20, y: Math.sin(i * 2.4) * Math.sqrt(i + 1) * 20 })),
  edges: Array.from({ length: 600 }, (_, i) => ({ source: `sources/parity-${i % 320}.md`, target: `sources/parity-${(i % 4 ? i + 7 : i % 3) % 320}.md`, weight: 1 + i % 8 })),
};
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    for (const width of reference ? [1440, 1912] : []) {
      const presentations = [];
      for (const probe of ['reference', 'production']) {
        const page = await browser.newPage({ viewport: { width, height: 1280 }, deviceScaleFactor: 2 });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.route('**/api/**', r => r.abort());
        await page.route(url => url.pathname === '/__parity.json', r => r.fulfill({ json: graph }));
        await page.goto(`${probe === 'reference' ? reference : base}/sidebar-workbench.html?graphSnapshot=/__parity.json&graphProbe=unified&graphEffects=none`);
        await page.waitForSelector('.lg-wrap canvas');
        await page.mouse.move(0, 0);
        const settle = () => page.waitForFunction(({ count }) => {
          const value = document.querySelector('.lg-wrap canvas')?.profilePresentation?.();
          if (!value?.nodes || value.nodes.length < count - 10) return false;
          const layout = JSON.parse(sessionStorage.getItem('bb:overview-layout:1') || 'null');
          if (!layout || layout.positions.length < count - 10) return false;
          const signature = JSON.stringify(value.nodes.map(n => [n.id, n.visible, n.x.toFixed(2), n.y.toFixed(2), n.height.toFixed(2), n.opacity.toFixed(3)]));
          window.parityStable = signature === window.parityPrevious ? (window.parityStable ?? 0) + 1 : 0;
          window.parityPrevious = signature;
          return window.parityStable >= 3;
        }, { probe, count: graph.nodes.length }, { polling: 500, timeout: 60000 });
        await settle();
        // Compare the explicit fitted home state, after the async layout arrives.
        // Startup camera sizing can race that worker in the original renderer.
        await page.mouse.dblclick(width - 8, 120);
        await settle();
        const presentation = await page.locator('.lg-wrap canvas').evaluate(c => c.profilePresentation());
        presentations.push(presentation);
        if (probe === 'production') {
          // Check the output pixels too: matching inspection data must not mask
          // a shader accidentally hiding every ordinary node.
          const png = await page.screenshot();
          const dark = await page.evaluate(async ({ url, nodes }) => {
            const img = new Image(); img.src = url; await img.decode();
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
            return nodes.filter(n => n.group === 'source' && n.opacity > .9 && n.height >= -18 && n.x > 350 && n.x < innerWidth - 20 && n.y > 80 && n.y < innerHeight - 20)
              .filter(n => ctx.getImageData(Math.round(n.x * devicePixelRatio), Math.round(n.y * devicePixelRatio), 1, 1).data[0] < 150).length;
          }, { url: `data:image/png;base64,${png.toString('base64')}`, nodes: presentation.nodes });
          assert(dark > 3, 'ordinary foreground nodes actually render');
        }
        assert.deepEqual(errors, []); await page.close();
      }
      const [original, gpu] = presentations, byId = new Map(gpu.nodes.map(n => [n.id, n]));
      assert.equal(original.nodes.length, gpu.nodes.length);
      for (const a of original.nodes) {
        const b = byId.get(a.id); assert(b);
        assert.equal(b.visible, a.visible, 'home membership');
        if (!a.visible) continue;
        assert(Math.abs(a.opacity - b.opacity) < .005, `home opacity: group=${a.group}, original=${a.opacity}, gpu=${b.opacity}`);
        assert(Math.abs(a.height - b.height) < .05, 'home depth');
        assert(Math.hypot(a.x - b.x, a.y - b.y) < .5, `home position within half a CSS pixel: viewport=${width}, group=${a.group}, original=${a.x},${a.y}, gpu=${b.x},${b.y}`);
      }
      console.log(`PASS: approved preview/production home membership, depth, opacity, positions and drawn source pixels at ${width}x1280 DPR2`);
    }
    const page = await browser.newPage();
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/sidebar-workbench.html?graphEffects=none`);
    const caps = await page.evaluate(async () => {
      const { GraphRenderer } = await import('/src/lib/graph/renderer.ts');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;top:0;left:0;width:600px;height:400px'; document.body.append(canvas);
      const values = [];
      for (const count of [1, 200]) {
        const renderer = new GraphRenderer(canvas, {
          nodes: [0, 1].map(i => ({ id: `memory-${i}`, title: 'Memory', group: 'memory', degree: 1, x: i * 100, y: 0 })),
          edges: Array.from({ length: count }, () => ({ source: 'memory-0', target: 'memory-1' })),
        });
        for (const width of [600, 700]) {
          canvas.style.width = `${width}px`; renderer.draw(performance.now() + 1000);
          const [a, b] = renderer.getPresentation().nodes, gl = canvas.getContext('webgl2');
          const pixels = new Uint8Array(7 * 7 * 4);
          gl.readPixels(Math.round((a.x + b.x) / 2 * devicePixelRatio) - 3, canvas.height - Math.round((a.y + b.y) / 2 * devicePixelRatio) - 3, 7, 7, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          values.push({ count, width, alpha: Math.max(...Array.from(pixels).filter((_, i) => i % 4 === 3)), error: gl.getError() });
        }
        renderer.dispose();
      }
      canvas.remove(); return values;
    });
    for (const result of caps) {
      assert.equal(result.error, 0, 'no framebuffer/sampler errors');
      assert(result.alpha > 0 && result.alpha < 100, 'crossing edge opacity is capped, including after resize/recreation');
    }
    assert(caps[2].alpha > caps[0].alpha, 'edge overlaps accumulate below the cap');
    console.log('PASS: actual GPU pixels cap 200 overlapping edges after resize and renderer recreation');
    await page.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
