const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/sidebar-workbench.html?profile=1&graphEffects=all&graphTheme=dusk`);
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor(); await page.waitForTimeout(1200);
    assert.equal(await canvas.evaluate(c => c.profilePresentation().effects), 'all');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dusk');
    await page.keyboard.press('j'); await page.waitForTimeout(1200);
    assert(await canvas.evaluate(c => c.profileStats.effectDrawCalls > 0));
    const result = await page.evaluate(async () => {
      const { GraphRenderer } = await import('/src/lib/graph/renderer.ts');
      // Keep an active foreground agent without links so dash animation does
      // not mask whether an optional effect itself sleeps at rest.
      const graph = { nodes: [0, 1, 2].map(i => ({ id: `effect-${i}`, title: `Effect ${i}`, group: i === 2 ? 'pilot' : 'source', ...(i === 2 ? { pilotPhase: 'answered', pilotActive: true } : {}), degree: 12, x: i * 120, y: i === 1 ? 80 : 0 })), edges: [{ source: 'effect-0', target: 'effect-1' }] };
      const changed = (a, b) => a.reduce((sum, v, i) => sum + (Math.abs(v - b[i]) > 1 ? 1 : 0), 0);
      const render = async (preset, theme, moving, reduced = false, phase = 'answered') => {
        document.documentElement.dataset.theme = theme;
        const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px'; document.body.append(c);
        const r = new GraphRenderer(c, { ...graph, nodes: graph.nodes.map(n => n.pilotPhase ? { ...n, pilotPhase: phase } : n) }, undefined, undefined, preset), gl = c.getContext('webgl2');
        let now = 10000;
        r.select('effect-0', now, reduced); r.draw(now += 2000); r.draw(now += 16);
        const before = { ...r.stats };
        if (moving) r.pan({ x: 12, y: 6 }, now + 16);
        r.draw(now += 16);
        const pixels = new Uint8Array(c.width * c.height * 4); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const effectDraws = r.stats.effectDrawCalls - before.effectDrawCalls, uploads = r.stats.uploads - before.uploads;
        const running = r.draw(now += 16), idle = new Uint8Array(pixels.length); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, idle);
        const sleeping = !r.draw(now += 1000), later = new Uint8Array(pixels.length); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, later);
        const error = gl.getError(); r.dispose(); gl.getExtension('WEBGL_lose_context')?.loseContext(); c.remove(); await new Promise(resolve => setTimeout(resolve, 0)); return { pixels, idle, later, sleeping, running, effectDraws, uploads, error };
      };
      const light = await render('none', 'default'), dark = await render('none', 'dusk');
      const glow = await render('glow', 'dusk'), lightGlow = await render('glow', 'default'), shadows = await render('shadows', 'default');
      const motion = await render('none', 'default', true), trails = await render('trails', 'default', true), still = await render('trails', 'default');
      const redBlue = { red: 0, blue: 0 };
      for (let i = 0; i < trails.pixels.length; i += 4) {
        if (motion.pixels[i + 3] > 245) continue;
        if (trails.pixels[i] - trails.pixels[i + 2] > 15) redBlue.red++;
        if (trails.pixels[i + 2] - trails.pixels[i] > 15) redBlue.blue++;
      }
      const breathing = await Promise.all(['default', 'dusk'].map(async theme => {
        const base = await render('none', theme, false, false, 'working'), halo = await render('breathing', theme, false, false, 'working');
        const energy = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);
        return { first: energy(halo.pixels, base.pixels), later: energy(halo.later, base.later), draws: halo.effectDraws, sleeping: halo.sleeping };
      }));
      const frozenHalo = await render('breathing', 'default', false, true, 'working'), answeredHalo = await render('breathing', 'default');
      const reduced = await render('trails', 'default', true, true), reducedBase = await render('none', 'default', true, true);
      return { redBlue, breathing, frozenHalo: changed(frozenHalo.pixels, frozenHalo.later), reducedSleeps: frozenHalo.sleeping, answeredHalo: changed(answeredHalo.pixels, light.pixels), answeredDraws: answeredHalo.effectDraws, darkGlow: changed(dark.pixels, glow.pixels), lightGlow: changed(light.pixels, lightGlow.pixels), shadows: changed(light.pixels, shadows.pixels),
        movingTrails: changed(motion.pixels, trails.pixels), idleTrails: changed(motion.idle, trails.idle), stillTrails: changed(light.pixels, still.pixels), reduced: changed(reduced.pixels, reducedBase.pixels),
        stopped: !trails.running, draws: [glow.effectDraws, lightGlow.effectDraws, shadows.effectDraws, trails.effectDraws, still.effectDraws, reduced.effectDraws],
        errors: [light, dark, glow, lightGlow, shadows, motion, trails, still, reduced, reducedBase].map(r => r.error), uploads: trails.uploads };
    });
    assert(result.redBlue.red > 5 && result.redBlue.blue > 5, 'both chromatic fringes must visibly escape the node');
    for (const halo of result.breathing) {
      assert(halo.first > 1000 && Math.abs(halo.first - halo.later) > halo.first * .05, 'halo breathes in light and dark themes');
      assert.equal(halo.draws, 1); assert.equal(halo.sleeping, false);
    }
    assert.equal(result.frozenHalo, 0); assert(result.reducedSleeps); assert.equal(result.answeredHalo, 0); assert.equal(result.answeredDraws, 0);
    assert(result.darkGlow > 100 && result.shadows > 100 && result.movingTrails > 10, JSON.stringify(result));
    assert.equal(result.lightGlow, 0); assert.equal(result.idleTrails, 0); assert.equal(result.stillTrails, 0); assert.equal(result.reduced, 0);
    assert(result.stopped, 'trails must clean up and sleep at rest'); assert.equal(result.uploads, 0, 'motion reuses state texture');
    assert.deepEqual(result.draws, [1, 0, 1, 1, 0, 0]); assert(result.errors.every(e => e === 0));
    await page.keyboard.press('Escape'); await page.waitForTimeout(1200);
    // Actual shell phase updates start/stop the halo without replacing resources.
    const phase = async value => page.evaluate(async phase => {
      const { chat } = await import('/src/lib/pilotChat.svelte.ts');
      chat.sessions = chat.sessions.map(s => ({ ...s, phase, revision: s.revision + 1 }));
    }, value);
    await phase('working'); await page.waitForFunction(() => document.querySelector('.graph-renderer canvas').profilePresentation().nodes.some(n => n.phase === 'working')); await page.waitForTimeout(300);
    const working = await canvas.evaluate(c => c.profileStats.breathingDrawCalls);
    await page.waitForTimeout(150); assert(await canvas.evaluate(c => c.profileStats.breathingDrawCalls) > working, JSON.stringify(await canvas.evaluate(c => ({ stats: c.profileStats, nodes: c.profilePresentation().nodes.filter(n => n.phase), alert: document.querySelector('[role=alert]')?.textContent }))));
    await phase('answered'); await page.waitForTimeout(1200);
    const stopped = await canvas.evaluate(c => c.profileStats.breathingDrawCalls);
    await page.waitForTimeout(150); assert.equal(await canvas.evaluate(c => c.profileStats.breathingDrawCalls), stopped);
    // Preset survives real shell WebGL context recovery.
    await canvas.evaluate(c => { const ext = c.getContext('webgl2').getExtension('WEBGL_lose_context'); ext.loseContext(); setTimeout(() => ext.restoreContext(), 100); });
    await page.waitForTimeout(1200); assert.equal(await canvas.evaluate(c => c.profilePresentation().effects), 'all');
    assert(await canvas.evaluate(c => c.profileStats.effectDrawCalls > 0));
    assert.deepEqual(errors, []);
    console.log('PASS: AppShell effects/theme selection, GPU glow/shadow/trail pixels, no idle or reduced-motion trails, cached state and context recovery', result);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
