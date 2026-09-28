const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    const stats = () => canvas.evaluate(c => ({ ...c.profileStats }));
    await canvas.evaluate(c => { c.originalStats = c.profileStats; });
    await page.keyboard.press('j'); await page.waitForTimeout(1200);
    const selected = await page.locator('.graph-renderer').getAttribute('data-selected');
    const point = (await scene()).nodes.find(n => n.id === agent);
    // Mutate fabricated production state, exercising the real shell and overlay pipeline.
    const phase = async value => {
      await page.evaluate(async ({ id, phase }) => {
        const { chat } = await import('/src/lib/pilotChat.svelte.ts');
        chat.sessions = chat.sessions.map(s => s.id === id ? { ...s, phase, draft: 'Check the design decisions', notifications: [], revision: s.revision + 1 } : s);
      }, { id: agent, phase: value });
      await page.waitForFunction(({ id, phase }) => document.querySelector('.graph-renderer canvas').profilePresentation().nodes.find(n => n.id === id)?.phase === phase, { id: agent, phase: value });
    };
    for (const value of ['working', 'interrupted', 'failed', 'draft', 'answered']) {
      await phase(value);
      assert(await canvas.evaluate(c => c.originalStats === c.profileStats), 'status update preserves renderer and GPU resources');
      assert.equal(await page.locator('.graph-renderer').getAttribute('data-selected'), selected);
      const after = (await scene()).nodes.find(n => n.id === agent);
      assert(Math.hypot(after.x - point.x, after.y - point.y) < .5, 'phase changes preserve camera');
      if (value === 'draft') assert.equal((await scene()).nodes.find(n => n.id === agent).draft, 'Check the design decisions');
    }
    await phase('working');
    const moving = await stats(); await page.waitForTimeout(250);
    assert((await stats()).frames > moving.frames + 2, 'working indicator keeps animating');
    assert.equal((await stats()).statusUploads, moving.statusUploads, 'animation does not upload status every frame');
    assert.equal((await stats()).labelUploads, moving.labelUploads, 'animation does not rasterize text every frame');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(1200);
    const reduced = await stats(); await page.waitForTimeout(250);
    assert.equal((await stats()).frames, reduced.frames, 'reduced motion displays a static working signal');
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await phase('answered');
    await page.waitForTimeout(1200); const idle = await stats(); await page.waitForTimeout(250);
    assert((await stats()).frames > idle.frames, 'roster-active agents retain moving context between turns');
    await page.evaluate(async id => {
      const { chat } = await import('/src/lib/pilotChat.svelte.ts');
      chat.sessions = chat.sessions.map(s => s.id === id ? { ...s, notifications: [{ id: 'question', kind: 'question', text: 'Continue?', resolved: false, seen: false }] } : s);
    }, agent);
    await page.waitForFunction(id => document.querySelector('.graph-renderer canvas').profilePresentation().nodes.find(n => n.id === id)?.attention, agent);
    const source = (await scene()).nodes.find(n => n.group === 'source' && !n.phase).id;
    for (const unread of [true, false]) {
      await page.evaluate(async ({ path, unread }) => {
        const { sourceAttention } = await import('/src/lib/sourceAttention.svelte.ts');
        sourceAttention.rows = [{ path, readState: { unread, status: 'synced', writable: true } }];
      }, { path: source, unread });
      await page.waitForFunction(({ id, unread }) => document.querySelector('.graph-renderer canvas').profilePresentation().nodes.find(n => n.id === id)?.attention === unread, { id: source, unread });
      assert(await canvas.evaluate(c => c.originalStats === c.profileStats), 'read receipts update without recreating renderer');
    }
    assert.equal(await page.locator('.lg-wrap canvas').count(), 1);
    const s = await stats(); assert.equal(s.drawCalls, s.frames * 4 + s.activityDrawCalls);
    await page.screenshot({ path: '/tmp/unified-status-shell.png' });

    // Compare actual GPU pixels to the original Canvas status shapes at fixed time.
    const pixels = await page.evaluate(async () => {
      const { GraphRenderer } = await import('/src/lib/graph/renderer.ts');
      const { drawPilotIndicator } = await import('/src/lib/pilotAppearance.ts');
      const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:240px'; document.body.append(c);
      const gallery = document.createElement('canvas'); gallery.width = 640; gallery.height = 8 * 100;
      const g = gallery.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, gallery.width, gallery.height);
      const phases = ['idle', 'active', 'draft', 'working', 'interrupted', 'failed', 'answered'];
      const differences = [];
      let animationDiff = 0, attentionPixels = 0, draftPixels = 0;
      const activityChecks = [];
      for (const theme of ['default', 'dusk']) {
      document.documentElement.dataset.theme = theme;
      const offset = theme === 'dusk' ? 320 : 0;
      const style = getComputedStyle(document.documentElement), bg = style.getPropertyValue('--bg').trim();
      const swatch = document.createElement('canvas').getContext('2d'); swatch.fillStyle = bg; swatch.fillRect(0, 0, 1, 1);
      const background = swatch.getImageData(0, 0, 1, 1).data;
      g.fillStyle = bg; g.fillRect(offset, 0, 320, 800);
      for (const [index, phase] of phases.entries()) {
        const graph = { hash: 'status-pixels', nodes: [{ id: 'agent', title: '', group: 'pilot', degree: 2, pilotPhase: phase, memorySupport: 1, pilotActive: phase !== 'idle' }], edges: [] };
        const renderer = new GraphRenderer(c, graph); const gl = c.getContext('webgl2'); assertNoError(gl, phase + ' constructor');
        const capture = time => {
          renderer.draw(time); assertNoError(gl, phase + ' draw');
          const p = renderer.getPresentation().nodes[0], r = Math.ceil(32 * devicePixelRatio);
          const bytes = new Uint8Array(r * r * 4); gl.readPixels(Math.round(p.x * devicePixelRatio - r / 2), Math.round(c.height - p.y * devicePixelRatio - r / 2), r, r, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          const crop = document.createElement('canvas'); crop.width = crop.height = r;
          const ctx = crop.getContext('2d'), image = ctx.createImageData(r, r);
          for (let y = 0; y < r; y++) for (let x = 0; x < r; x++) {
            const dst = (y * r + x) * 4, src = ((r - y - 1) * r + x) * 4, a = bytes[src + 3];
            for (let k = 0; k < 3; k++) image.data[dst + k] = bytes[src + k] + background[k] * (1 - a / 255);
            image.data[dst + 3] = 255;
          }
          ctx.putImageData(image, 0, 0); return { crop, data: image.data, p };
        };
        const sample = capture(2200);
        const native = document.createElement('canvas'); native.width = native.height = 64; const n = native.getContext('2d');
        n.fillStyle = bg; n.fillRect(0, 0, 64, 64); n.scale(2, 2);
        drawPilotIndicator(n, 16, 16, sample.p.radius, phase, false, 2200, false, style.getPropertyValue('--mark').trim(), bg, style.getPropertyValue('--activity').trim(), undefined, sample.p.inkOpacity);
        const reference = n.getImageData(0, 0, 64, 64).data;
        const error = sample.data.reduce((sum, v, i) => sum + Math.abs(v - reference[i]), 0);
        const signal = reference.reduce((sum, v, i) => sum + Math.abs(background[i % 4] - v), 0);
        differences.push({ theme, phase, relativeError: error / signal });
        g.fillStyle = style.getPropertyValue('--mark').trim(); g.font = '14px system-ui'; g.fillText(phase, offset + 10, index * 100 + 50);
        g.drawImage(native, offset + 160, index * 100 + 10); g.drawImage(sample.crop, offset + 250, index * 100 + 10);
        if (phase === 'working') {
          const next = capture(2450); animationDiff = next.data.reduce((sum, v, i) => sum + Math.abs(v - sample.data[i]), 0);
        }
        if (phase === 'draft') {
          renderer.update({ ...graph, nodes: [{ ...graph.nodes[0], pilotDraft: 'Draft text' }] });
          renderer.draw(2200); const bytes = new Uint8Array(c.width * c.height * 4); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          const p = renderer.getPresentation().nodes[0];
          for (let y = Math.round((p.y + 35) * 2); y < Math.min(c.height, (p.y + 65) * 2); y++) for (let x = 0; x < c.width; x++) draftPixels += bytes[((c.height - 1 - y) * c.width + x) * 4 + 3];
        }
        assertNoError(gl); renderer.dispose();
      }
      }
      document.documentElement.dataset.theme = 'default';
      // Attention corners must exist in GPU output, not just metadata.
      const renderer = new GraphRenderer(c, { hash: 'unread', nodes: [{ id: 'source', title: '', group: 'source', degree: 2, readState: { unread: true } }], edges: [] });
      renderer.draw(1800); const p = renderer.getPresentation().nodes[0], gl = c.getContext('webgl2');
      const bytes = new Uint8Array(c.width * c.height * 4); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      const radius = Math.max(7, p.radius + 5);
      for (let sy of [-1, 1]) for (let sx of [-1, 1]) {
        const x = Math.round((p.x + sx * radius) * 2), y = c.height - Math.round((p.y + sy * radius) * 2);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) attentionPixels += bytes[((y + dy) * c.width + x + dx) * 4 + 3];
      }
      assertNoError(gl); renderer.dispose();
      for (const status of [{ pending: true }, { live: 'working' }, { live: 'waiting' }]) {
        const graph = { hash: 'activity', nodes: [
          { id: 'memory', title: '', group: 'memory', degree: 1 },
          { id: 'source', title: '', group: 'source', degree: 1, ...status },
        ], edges: [{ source: 'memory', target: 'source' }] };
        const activity = new GraphRenderer(c, graph);
        const read = time => { activity.draw(time); const bytes = new Uint8Array(c.width * c.height * 4); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return bytes; };
        const first = read(2200), next = read(2450);
        const motion = next.reduce((sum, v, i) => sum + Math.abs(v - first[i]), 0);
        activity.update({ ...graph, nodes: [graph.nodes[0], { ...graph.nodes[1], pending: undefined, live: undefined }] });
        const ordinary = read(2450), signal = ordinary.reduce((sum, v, i) => sum + Math.abs(v - next[i]), 0);
        activity.update(graph); activity.select(null, 0, true);
        const reducedContinues = activity.draw(2450);
        activityChecks.push({ status, motion, signal, reducedContinues });
        assertNoError(gl); activity.dispose();
      }
      c.remove();
      return { differences, animationDiff, attentionPixels, draftPixels, activityChecks, gallery: gallery.toDataURL() };
      function assertNoError(gl, label = '') { const code = gl.getError(); if (code !== gl.NO_ERROR) throw Error(`WebGL error ${code} ${label}`); }
    });
    fs.writeFileSync('/tmp/unified-status-parity.png', Buffer.from(pixels.gallery.split(',')[1], 'base64'));
    assert(pixels.differences.every(d => d.relativeError < .35), JSON.stringify(pixels.differences));
    assert(pixels.animationDiff > 1000, 'working arc moves in actual GPU pixels');
    assert(pixels.attentionPixels > 1000, 'unread attention corners render');
    assert(pixels.draftPixels > 1000, 'draft text renders below the agent');
    assert(pixels.activityChecks.every(c => c.motion > 1000 && c.signal > 1000 && !c.reducedContinues), JSON.stringify(pixels.activityChecks));
    assert.deepEqual(errors, []);
    console.log('PASS: production-shell live phases, camera/resource continuity, unread/needs-you, reduced motion, sleep, batched draws, GPU/native shape comparison, animated pixels and draft text', pixels.differences);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
