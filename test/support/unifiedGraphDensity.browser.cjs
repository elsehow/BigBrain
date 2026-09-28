const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/sidebar-workbench.html?graphEffects=none`);
    const result = await page.evaluate(async () => {
      const { GraphRenderer } = await import('/src/lib/graph/renderer.ts');
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'position:fixed;inset:0;width:1440px;height:1000px'; document.body.append(canvas);
      const degree = 64;
      const nodes = Array.from({ length: degree * 2 + 1 }, (_, i) => ({ id: String(i), title: `Node ${i}`, group: 'source', degree: i <= degree ? degree : 1, x: Math.cos(i * 2.4) * Math.sqrt(i + 1) * 30, y: Math.sin(i * 2.4) * Math.sqrt(i + 1) * 30 }));
      const edges = [];
      for (let i = 1; i <= degree; i++) {
        edges.push({ source: '0', target: String(i) }, { source: String(i), target: String(i + degree) });
        for (let j = i + 1; j <= degree; j++) edges.push({ source: String(i), target: String(j) });
      }
      const renderer = new GraphRenderer(canvas, { nodes, edges }); renderer.draw(performance.now());
      renderer.select('0');
      await new Promise(resolve => setTimeout(resolve, 1100)); renderer.draw(performance.now());
      const scene = renderer.getPresentation(), gl = canvas.getContext('webgl2'), alphas = [];
      const byId = new Map(scene.nodes.map(n => [n.id, n]));
      for (const edge of scene.edges) {
        const a = byId.get(edge.source), b = byId.get(edge.target), x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
        if (x < 10 || y < 10 || x >= 1430 || y >= 990 || scene.nodes.some(n => Math.hypot(n.x - x, n.y - y) < 15)) continue;
        // Selected source titles now render above the edge layer. Sample only
        // unobscured edges, just as we already exclude foreground node pixels.
        if (scene.labels.some(b => x >= b.left - 1 && x <= b.left + b.width + 1 && y >= b.top - 1 && y <= b.top + b.height + 1)) continue;
        const pixel = new Uint8Array(4); gl.readPixels(Math.round(x), canvas.height - Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); alphas.push(pixel[3]);
        if (alphas.length === 50) break;
      }
      const answer = { secondOpacity: scene.nodes.filter(n => Number(n.id) > degree).map(n => n.inkOpacity),
        spokes: scene.edges.filter(e => e.source === '0').map(e => e.ink),
        background: scene.edges.filter(e => Number(e.source) > 0 && Number(e.target) <= degree).map(e => e.ink), alphas, error: gl.getError() };
      renderer.dispose(); canvas.remove(); return answer;
    });
    assert(result.secondOpacity.every(v => v <= .081), 'ordinary selections do not promote second-hop nodes');
    assert(result.spokes.every(v => v === 1), 'real spokes keep their emphasis within the density-adjusted layer');
    assert(result.background.every(v => v > 0 && v <= .06), 'dense neighbor mesh remains faint context');
    assert(result.alphas.length > 10 && result.alphas.some(v => v > 0), 'real edges render between nodes');
    assert(Math.max(...result.alphas) < 65, 'dense crossing pixels stay below the density-adjusted opacity ceiling');
    assert.equal(result.error, 0);
    console.log('PASS: 64-neighbor dense selection, quiet second hop, attenuated spokes/mesh, actual edge pixel ceiling');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
