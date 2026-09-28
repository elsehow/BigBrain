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
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor();
    await page.waitForTimeout(1400);
    const agent = 'pilot-11111111111111111111111111111111';
    const scene = () => canvas.evaluate(c => c.profilePresentation());
    const initial = await scene();
    assert(initial.edges.some(e => e.target === agent && e.activity > .99 && e.moving), 'production context links are active at home');
    await canvas.evaluate(c => { c.originalStats = c.profileStats; });
    const active = initial.nodes.filter(n => n.phase && n.phase !== 'idle');
    assert(active.length >= 3, 'fixture covers several independent active agents');
    const connections = state => {
      for (const agent of active) {
        const node = state.nodes.find(n => n.id === agent.id);
        assert.equal(node.height, 80, 'active agent stays at the foreground depth');
        assert.equal(node.inkOpacity, 1, 'active agent remains legible outside focus');
        const links = state.edges.filter(e => e.source === agent.id || e.target === agent.id);
        assert(links.length && links.every(e => e.activity > .99 && e.moving), 'every active agent keeps its real connections outside the selection');
      }
    };
    connections(initial);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('j'); await page.waitForTimeout(800); connections(await scene());
    }
    await page.keyboard.press('Escape'); await page.waitForTimeout(1200);
    const p = (await scene()).nodes.find(n => n.id === agent);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(1200);
    assert.equal((await scene()).hovered, agent); connections(await scene());
    await page.screenshot({ path: '/tmp/unified-agent-connections.png' });
    const before = await canvas.evaluate(c => ({ ...c.profileStats }));
    await page.waitForTimeout(250);
    const after = await canvas.evaluate(c => ({ ...c.profileStats }));
    assert(after.frames > before.frames && after.activityDrawCalls > before.activityDrawCalls);
    assert.equal(after.activityUploads, before.activityUploads, 'dash motion does not upload geometry');
    await page.evaluate(async id => {
      const { chat } = await import('/src/lib/pilotChat.svelte.ts');
      chat.sessions = chat.sessions.map(s => s.id === id ? { ...s, deactivatedAt: new Date().toISOString(), phase: 'answered', notifications: [] } : s);
    }, agent);
    await page.waitForTimeout(1200);
    assert(await canvas.evaluate(c => c.originalStats === c.profileStats), 'context status changes preserve renderer');
    assert((await scene()).nodes.find(n => n.id === agent).height < 0, 'archiving during hover releases the foreground depth');
    assert((await scene()).edges.filter(e => e.target === agent).every(e => e.activity === 0 && !e.moving), 'closed agent loses activity links');

    // Snapshot previews must attach every fabricated agent to real snapshot
    // context rather than to a source that only exists in the sample scene.
    await page.route(url => url.pathname === '/agent-snapshot.json', r => r.fulfill({ json: { hash: 'agent-snapshot', nodes: [
      { id: 'memory/one.md', title: 'One', group: 'memory', degree: 1 },
      { id: 'memory/two.md', title: 'Two', group: 'memory', degree: 1 },
      { id: 'snapshot-source', title: 'Evidence', group: 'source', degree: 2 },
    ], edges: [
      { source: 'memory/one.md', target: 'snapshot-source' },
      { source: 'memory/two.md', target: 'snapshot-source' },
    ] } }));
    await page.goto(`${base}/sidebar-workbench.html?graphSnapshot=/agent-snapshot.json`);
    await canvas.waitFor().catch(e => { throw new Error(`${e.message}; page errors: ${errors.join('; ')}`); });
    await page.waitForTimeout(1400); connections(await scene());

    const result = await page.evaluate(async () => {
      const { GraphRenderer } = await import('/src/lib/graph/renderer.ts');
      const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:700px'; document.body.append(c);
      const graph = { hash: 'activity-pixels', nodes: [
        { id: 'memory', title: '', group: 'memory', degree: 2 },
        { id: 'agent', title: '', group: 'pilot', degree: 1, memorySupport: 1, pilotPhase: 'working', pilotActive: true, layoutAnchors: ['memory'], layoutOffset: { x: 160, y: -160 } },
        { id: 'history', title: '', group: 'pilot', degree: 1, memorySupport: 1, pilotPhase: 'idle', layoutAnchors: ['memory'], layoutOffset: { x: -160, y: -160 } },
      ], edges: [{ source: 'memory', target: 'agent', pilotContext: true }, { source: 'memory', target: 'history' }] };
      const renderer = new GraphRenderer(c, graph), gl = c.getContext('webgl2');
      const capture = t => {
        renderer.draw(t);
        const bytes = new Uint8Array(c.width * c.height * 4); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        if (gl.getError() !== gl.NO_ERROR) throw Error('WebGL readback error');
        return { bytes, scene: renderer.getPresentation(t) };
      };
      const time = performance.now() + 2000;
      const first = capture(time), later = capture(time + 106.25);
      const memory = first.scene.nodes[0];
      const center = (Math.round(c.height - 1 - memory.y * 2) * c.width + Math.round(memory.x * 2)) * 4;
      const centerAlpha = first.bytes[center + 3];
      const a = first.scene.nodes[0], b = first.scene.nodes[1], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      const sample = (frame, distance) => {
        const from = frame.scene.nodes[0], to = frame.scene.nodes[1], t = distance / length;
        const x = Math.round((from.x + (to.x - from.x) * t) * 2), y = c.height - 1 - Math.round((from.y + (to.y - from.y) * t) * 2);
        return frame.bytes[(y * c.width + x) * 4 + 3];
      };
      // Interior samples avoid node fills and selection rings.
      const start = Math.max(30, length * .3), count = Math.min(140, Math.floor(length * .4));
      const strip = Array.from({ length: count }, (_, i) => sample(first, start + i));
      const shifted = Array.from({ length: count }, (_, i) => sample(later, start + i));
      const on = strip.filter(v => v > 10).length, off = strip.filter(v => v < 3).length;
      const differences = strip.filter((v, i) => Math.abs(v - shifted[i]) > 10).length;
      const peak = Math.max(...strip);
      // Only complete rising edges count; the strip may begin midway through a dash.
      const runs = strip.flatMap((v, i) => i > 0 && v > 10 && strip[i - 1] <= 10 ? [i] : []);
      const periods = runs.slice(1).map((v, i) => v - runs[i]);
      renderer.hover('agent', performance.now() - 2000); const engaged = capture(time);
      const hoverPeak = Math.max(...Array.from({ length: count }, (_, i) => sample(engaged, start + i)));
      // Reduced motion retains the cue and produces identical pixels over time.
      renderer.select('agent', performance.now() - 2000, true);
      const reduced = capture(time), reducedLater = capture(time + 220);
      const reducedDiff = reduced.bytes.reduce((sum, v, i) => sum + Math.abs(v - reducedLater.bytes[i]), 0);
      const historical = reduced.scene.edges.find(e => e.target === 'history');
      const selected = reduced.scene.edges.find(e => e.target === 'agent');
      const identity = renderer.stats;
      const noContext = { ...graph, edges: graph.edges.map(e => ({ ...e, pilotContext: false })) };
      const updated = renderer.update(noContext);
      const unflagged = capture(performance.now() + 2000).scene.edges.find(e => e.target === 'agent');
      const closed = { ...noContext, nodes: noContext.nodes.map(n => n.id === 'agent' ? { ...n, pilotPhase: 'idle', pilotActive: false } : n) };
      renderer.select(null, performance.now() - 2000, false); capture(performance.now() + 2000);
      renderer.update(closed);
      const archived = capture(performance.now() + 2000).scene;
      renderer.update(graph);
      const reactivated = capture(performance.now() + 2000).scene;
      const stable = renderer.stats === identity;
      renderer.dispose(); c.remove();
      return { centerAlpha, archived, reactivated, count, on, off, differences, peak, hoverPeak, periods, reducedDiff, historical, selected, updated, unflagged, stable };
    });
    assert.equal(result.centerAlpha, 0, 'memory center has no misleading activity dot');
    assert(result.count >= 40, JSON.stringify(result));
    assert(result.on > 10 && result.off > 10, 'GPU line has real gaps');
    assert(result.periods.length >= 2 && result.periods.every(p => Math.abs(p - 14) <= 1), `7px dash/7px gap: ${result.periods}`);
    assert(result.differences > result.count * .2, 'dashes move in actual pixels');
    assert(result.hoverPeak > result.peak * 2, `hover emphasizes connections: ${result.peak} → ${result.hoverPeak}`);
    assert.equal(result.reducedDiff, 0, 'reduced motion freezes dashes and node indicators');
    assert.equal(result.selected.activity, 1); assert.equal(result.selected.moving, false);
    assert.equal(result.historical.activity, 0, 'historical edges do not become active connections');
    assert(result.updated && result.stable && result.unflagged.activity === 1, 'active connections survive context-flag changes without rebuilding');
    assert.equal(result.archived.nodes.find(n => n.id === 'agent').height, -18, 'archived agent returns to its memory-evidence depth');
    assert(result.archived.edges.every(e => e.activity === 0 && !e.moving), 'archived edges use ordinary ink');
    assert.equal(result.reactivated.nodes.find(n => n.id === 'agent').height, 80);
    assert(result.reactivated.edges.find(e => e.target === 'agent').activity > .99, 'reactivation restores links');
    assert.deepEqual(errors, []);
    console.log('PASS: production active/closed agents, hover, static geometry, real 7px dashes/gaps and motion, hover emphasis, reduced motion, archival depth and reactivation, all active connections, clear memory centers');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
