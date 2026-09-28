const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
 const browser = await webkit.launch({ headless: true });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', r => r.abort()); await page.goto(`${base}/sidebar-workbench.html`);
  const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor(); await page.waitForTimeout(1200);
  const scene = () => canvas.evaluate(c => c.profilePresentation());
  const home = await scene();
  const source = home.nodes.find(n => n.group === 'source' && home.edges.some(e => e.source === n.id || e.target === n.id));
  await page.evaluate(async id => { (await import('/src/lib/stage.svelte.ts')).stage.pilotPreviewId = id; }, source.id);
  await page.waitForTimeout(1200);
  const highlighted = await scene();
  assert.deepEqual(highlighted.highlighted, [source.id]);
  assert.deepEqual(highlighted.camera, home.camera); assert.deepEqual(highlighted.view, home.view);
  const neighbors = highlighted.edges.filter(e => e.source === source.id || e.target === source.id);
  assert(neighbors.every(e => e.ink > .99));
  const ids = new Set(neighbors.flatMap(e => [e.source, e.target]));
  assert(highlighted.nodes.filter(n => ids.has(n.id)).every(n => n.inkOpacity > .99), 'app highlight lights the root and first-degree neighbors');
  const memory = home.nodes.find(n => n.group === 'memory');
  await page.evaluate(async id => {
   (await import('/src/lib/stage.svelte.ts')).stage.pilotPreviewId = null;
   (await import('/src/lib/store.svelte.ts')).gotoNote(id);
  }, memory.id);
  const link = page.locator('.drawer:not(.sidebar-quick) .source-link').first(); await link.waitFor();
  await page.waitForTimeout(1200); const before = await scene();
  await page.keyboard.press('j'); await page.waitForTimeout(1200);
  const path = await page.locator('.drawer:not(.sidebar-quick) .source-link.lk-on').first().getAttribute('data-path');
  const probed = await scene();
  assert(probed.highlighted.includes(path), 'the actual NoteTab keyboard probe reaches the graph');
  assert.deepEqual(probed.camera, before.camera); assert.deepEqual(probed.view, before.view);
  assert.equal(probed.hovered, null, 'probe does not start a pointer excavation');
  assert.deepEqual(errors, []);
  console.log('PASS: app highlights and real NoteTab j/k probes emphasize direct connections without moving the camera or changing selection');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
