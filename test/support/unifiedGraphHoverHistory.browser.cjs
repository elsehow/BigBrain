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
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor(); await page.waitForTimeout(1500);
    const home = await canvas.evaluate(c => c.profilePresentation());
    const root = home.nodes.find(n => n.id === 'memory/project.md'); assert(root);
    await page.mouse.move(root.x, root.y); await page.waitForTimeout(800);
    const hovered = await canvas.evaluate(c => c.profilePresentation());
    const held = hovered.nodes.find(n => n.id === root.id);
    const neighbors = new Set(hovered.edges.filter(e => e.source === root.id || e.target === root.id).map(e => e.source === root.id ? e.target : e.source));
    assert(neighbors.size > 0 && hovered.nodes.filter(n => neighbors.has(n.id)).every(n => n.inkOpacity > .99), 'AppShell hover highlights the actual first-degree neighborhood');
    assert.equal(hovered.hovered, root.id); assert.equal(held.height, root.height);
    assert(Math.hypot(held.x - root.x, held.y - root.y) < .5, 'hovered node stays under the actual pointer');
    await page.mouse.move(1439, 999); await page.waitForTimeout(1500);
    const waiting = await canvas.evaluate(c => c.profilePresentation());
    await page.waitForTimeout(3500);
    const restored = await canvas.evaluate(c => c.profilePresentation());
    assert(waiting.nodes.some((n, i) => n.height < home.nodes[i].height - 20), 'hover-out holds the excavation');
    for (let i = 0; i < home.nodes.length; i++) assert(Math.abs(restored.nodes[i].height - home.nodes[i].height) < .05, 'sleeping shell wakes to restore home depth');
    const result = await page.evaluate(async () => {
      const { GraphRenderer } = await import('/src/lib/graph/renderer.ts');
      const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px'; document.body.append(c);
      const graph = { nodes: Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, title: '', group: i === 0 ? 'memory' : 'source', degree: 3, x: i * 100, y: i % 2 * 80 })),
        edges: [[0,1],[1,2],[2,3]].map(([a,b]) => ({ source: `h${a}`, target: `h${b}` })) };
      const r = new GraphRenderer(c, graph); let now = 10000; r.draw(now);
      const scene = () => r.getPresentation(now).nodes;
      const initial = scene(); r.hover('h1', now); r.draw(now += 800); const first = scene();
      r.hover('h2', now); r.draw(now += 800); const second = scene();
      r.hover('h3', now); r.draw(now += 800); const third = scene();
      r.hover(null, now); const leaveAt = now; r.draw(now += 1200); const held = scene(), asleep = !r.draw(now), wake = r.nextWake;
      r.draw(now = leaveAt + 2500); const returnStart = scene(), uploads = r.stats.uploads;
      r.draw(now += 900); const half = scene(); r.draw(now += 900); const end = scene();
      const stableUploads = r.stats.uploads === uploads;
      // A new hover interrupts return continuously and still pins its anchor.
      r.hover('h1', now); r.draw(now += 800); r.hover(null, now); r.draw(now += 2500); r.draw(now += 700);
      const interrupted = scene(); r.hover('h4', now); r.draw(now); const continuous = scene(); r.draw(now += 800); const repinned = scene();
      r.refit(now); r.draw(now += 1200); const reset = scene();
      r.select('h0', now); r.draw(now); r.draw(now += 80); const selectedBefore = scene();
      r.hover('h2', now); r.draw(now += 800); const selectedHover = scene();
      r.select('h0', now); r.draw(now); r.draw(now += 1200); r.hover('h1', now); r.draw(now += 800); r.select('h0', now);
      const sameSelectionClears = r.getPresentation(now).hovered === null && r.nextWake === null;
      r.select(null, now, true); r.hover('h1', now); r.draw(now += 800); r.hover(null, now); r.draw(now += 1200);
      const reduced = { heights: scene().map(n => n.height), wake: r.nextWake, sleeping: !r.draw(now) };
      const gl = c.getContext('webgl2'), error = gl.getError(); r.dispose(); gl.getExtension('WEBGL_lose_context')?.loseContext(); c.remove();
      return { initial, first, second, third, held, asleep, wake, leaveAt, returnStart, half, end, stableUploads, interrupted, continuous, repinned, reset, selectedBefore, selectedHover, sameSelectionClears, reduced, error };
    });
    const { initial, first, second, third } = result;
    assert.equal(first[1].height, initial[1].height);
    assert(first[0].inkOpacity > .99 && first[2].inkOpacity > .99, 'hover highlights every direct neighbor at full foreground ink');
    assert(first[4].inkOpacity < .5, 'unrelated nodes do not inherit the highlight');
    assert(second[0].inkOpacity < first[0].inkOpacity, 'previous neighborhood loses active emphasis but keeps its depth history');
    assert(first[0].height >= initial[0].height && first[2].height >= initial[2].height, 'first-degree connections stay up');
    assert(first[4].height <= initial[4].height - 79, 'unvisited nodes descend');
    assert.equal(second[2].height, first[2].height);
    assert(third[1].opacity > .95, 'older explored nodes remain readable');
    assert(third[1].height < second[1].height && third[1].height > third[4].height + 50, 'previous neighborhoods form shallow layers');
    assert(result.asleep); assert.equal(result.wake, result.leaveAt + 2500);
    for (let i = 0; i < initial.length; i++) {
      assert(Math.abs(result.held[i].height - third[i].height) < .05, 'hold preserves layers');
      assert(Math.abs(result.half[i].height - (result.returnStart[i].height + initial[i].height) / 2) < .05, 'sinusoidal return reaches midpoint');
      assert(Math.abs(result.end[i].height - initial[i].height) < .05);
      assert(Math.abs(result.end[i].inkOpacity - initial[i].inkOpacity) < .001, 'return restores home ink too');
      assert(Math.abs(result.continuous[i].height - result.interrupted[i].height) < .05, 'interrupt does not jump');
      assert(Math.abs(result.reset[i].height - initial[i].height) < .05, 'explicit home clears history');
    }
    assert(Math.abs(result.repinned[4].height - result.interrupted[4].height) < .001, 'reentered anchor keeps its sampled depth');
    assert(result.repinned[1].height > result.repinned[5].height + 50, 'reentering during return preserves previously explored layers');
    assert(result.sameSelectionClears, 'clicking the existing selection clears excavation too');
    assert(result.stableUploads, 'return frames interpolate on GPU without state uploads');
    assert(result.reduced.heights.every(h => h === 0)); assert.equal(result.reduced.wake, null); assert(result.reduced.sleeping);
    assert(Math.hypot(result.selectedBefore[2].x - result.selectedHover[2].x, result.selectedBefore[2].y - result.selectedHover[2].y) < .01, 'hover takes over an in-flight camera without moving the pointed node');
    assert.equal(result.error, 0); assert.deepEqual(errors, []);
    console.log('PASS: production-shell stationary hover and delayed wake; first-degree excavation, retained layers, sinusoidal return, interruption, GPU state reuse, home reset and reduced motion');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
