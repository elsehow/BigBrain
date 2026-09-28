/** Automated production-shell j/k walk against fabricated workbench data.
 * Start Vite on 53490, then: node test/support/profileHomeWalk.cjs
 * REPEATS=3 PROFILE_OUT=/tmp/home-walk.json defaults to headless WebKit.
 * HEADLESS=0 enables a visible window; resizing it invalidates the run.
 * Measures rAF cadence, not GPU time or Safari Inspector composite events.
 */
const { webkit, chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const expectedCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
const repeats = Number(process.env.REPEATS || 3);
const engine = process.env.PROFILE_ENGINE || 'webkit';
const out = process.env.PROFILE_OUT || '/tmp/home-walk.json';
const headless = process.env.HEADLESS !== '0';
const graph = process.env.PROFILE_GRAPH_FILE ? JSON.parse(fs.readFileSync(process.env.PROFILE_GRAPH_FILE, 'utf8')) : null;
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor((sorted.length - 1) * .95)],
    over25ms: sorted.filter(v => v > 25).length };
};
(async () => {
  assert(Number.isInteger(repeats) && repeats > 0);
  const windowsBeforeLaunch = !headless && process.env.PROFILE_FLOAT === '1'
    ? execFileSync('aerospace', ['list-windows', '--all', '--format', '%{window-id}'], { encoding: 'utf8' }).trim().split('\n') : [];
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({
    headless, ...(engine === 'chromium' ? { channel: 'chrome' } : {}),
  });
  const results = [];
  try {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const cases = (process.env.PROFILE_WIDTH ? [Number(process.env.PROFILE_WIDTH)] : [1883, 3790])
        .flatMap(width => (process.env.PROFILE_EFFECTS || 'all').split(',').map(effect => [width, effect]));
      if (repeat % 2) cases.reverse();
      for (const [width, effect] of cases) {
        const context = await browser.newContext({ viewport: { width, height: 1183 }, deviceScaleFactor: Number(process.env.PROFILE_DPR || 2) });
        try {
          // No live backend traffic, including the Vite /api proxy.
          await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (graph && url.origin === new URL(base).origin && url.pathname === '/__profile_graph.json') return route.fulfill({ json: graph });
            return url.origin === new URL(base).origin && !url.pathname.startsWith('/api/')
              ? route.continue() : route.abort();
          });
          const page = await context.newPage();
          if (!headless && process.env.PROFILE_FLOAT === '1') {
            await page.goto(`${base}/sidebar-workbench.html?graphEffects=${effect}`);
            let id, windows;
            for (let attempt = 0; attempt < 50 && !id; attempt++) {
              await page.waitForTimeout(100);
              windows = execFileSync('aerospace', ['list-windows', '--all', '--format', '%{window-id}|%{app-name}'], { encoding: 'utf8' });
              const candidates = windows.split('\n').filter(line => !windowsBeforeLaunch.includes(line.split('|')[0]) && /Playwright|MiniBrowser/.test(line));
              if (candidates.length === 1) id = candidates[0].split('|')[0];
            }
            assert(id, `cannot identify profiling window; refusing to resize other windows: ${windows}`);
            execFileSync('aerospace', ['layout', '--window-id', id, 'floating']);
          }
          await page.setViewportSize({ width, height: 1183 });
          const errors = [];
          page.on('pageerror', e => errors.push(e.message));
          await page.addInitScript(() => {
            const native = window.requestAnimationFrame.bind(window);
            window.walkProfile = { active: false, callbacks: [], intervals: [], sizes: [] };
            window.requestAnimationFrame = callback => native(time => {
              const start = performance.now();
              try { callback(time); } finally {
                if (window.walkProfile.active) window.walkProfile.callbacks.push(performance.now() - start);
              }
            });
            let last;
            const sample = time => {
              if (window.walkProfile.active && last !== undefined) window.walkProfile.intervals.push(time - last);
              if (window.walkProfile.active) window.walkProfile.sizes.push([innerWidth, innerHeight]);
              last = window.walkProfile.active ? time : undefined;
              native(sample);
            };
            native(sample);
          });
          await page.goto(`${base}/sidebar-workbench.html?graphEffects=${effect}${graph ? '&graphSnapshot=/__profile_graph.json' : ''}`);
          await page.locator('.lg-wrap > canvas').first().waitFor({ state: 'attached' });
          // Benchmark the settled overview, at full display resolution.
          await page.waitForFunction(count => {
            const layout = JSON.parse(sessionStorage.getItem('bb:overview-layout:1') || 'null');
            return layout?.positions?.length >= Math.max(1, count - 10);
          }, graph?.nodes.length ?? 1, { timeout: 60000 });
          await page.waitForTimeout(2500);
          await page.keyboard.press('j');
          await page.locator('.workspace-menu .menu-row[aria-current="true"]').waitFor().catch(async error => {
            await page.screenshot({ path: '/tmp/home-walk-failure.png' });
            console.error(errors, await page.locator('body').innerText());
            throw error;
          });
          await page.keyboard.press('k');
          await page.waitForTimeout(500);
          const timeline = [];
          let timelineSession;
          if (process.env.PROFILE_TIMELINE === '1') {
            assert.equal(engine, 'webkit');
            // Diagnostic-only bridge, pinned to this repo's Playwright version.
            // Fail explicitly if its private WebKit protocol changes.
            timelineSession = page._connection.toImpl(page).delegate._session;
            timelineSession.on('Timeline.eventRecorded', event => timeline.push(event.record));
            await timelineSession.send('Timeline.start', { maxCallStackDepth: 0 });
          }
          await page.evaluate(() => { window.walkProfile.active = true; });
          const selections = [];
          for (const key of [...Array(12).fill('j'), ...Array(12).fill('k')]) {
            await page.keyboard.press(key);
            await page.waitForTimeout(180);
            selections.push(await page.locator('.workspace-menu .menu-row[aria-current="true"]').innerText());
          }
          const data = await page.evaluate(() => {
            window.walkProfile.active = false;
            return { ...window.walkProfile, dpr: devicePixelRatio,
              provenance: document.querySelector('#preview-provenance')?.textContent,
              canvases: [...document.querySelectorAll('.lg-wrap > canvas')].map(c => ({
                width: c.width, height: c.height, cssWidth: c.clientWidth, cssHeight: c.clientHeight,
                layer: c.className || 'main', visibility: getComputedStyle(c).visibility,
                opacity: getComputedStyle(c).opacity,
              })) };
          });
          if (timelineSession) await timelineSession.send('Timeline.stop');
          assert(new Set(selections).size > 1, 'j/k must actually change the preview');
          assert(data.provenance?.includes(expectedCommit), 'preview must match this checkout');
          assert.equal(await page.locator('html').getAttribute('data-sidebar-workbench'), 'closed', 'walk must stay in the production home shell');
          assert(data.sizes.every(([w, h]) => w === width && h === 1183), 'viewport changed; discard this run');
          assert(data.intervals.length > 20, 'must record frame cadence');
          for (const c of data.canvases) assert.equal(c.width, Math.round(c.cssWidth * data.dpr));
          assert.deepEqual(errors, []);
          const row = { repeat, width, effect, renderer: 'webgl', engine, browserVersion: browser.version(),
            timeline,
            graphNodes: graph?.nodes.length ?? null, graphEdges: graph?.edges.length ?? null,
            headless, distinctSelections: new Set(selections).size,
            frameIntervals: stats(data.intervals), callbackDurations: stats(data.callbacks), ...data };
          results.push(row);
          fs.writeFileSync(out, JSON.stringify(results, null, 2));
          console.log(JSON.stringify({ repeat, width, effect, frames: row.frameIntervals, callbacks: row.callbackDurations }));
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
