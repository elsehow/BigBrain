const { webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
const ids = ['memory/alpha.md', 'memory/beta.md', 'sources/a.md', 'sources/b.md', 'sources/c.md'];
const graph = {
  nodes: ids.map((id, i) => ({ id, path: id, title: `Interaction ${i}`, group: i < 2 ? 'memory' : 'source', degree: 3, x: i * 40, y: i * 20 })),
  edges: [[0,2],[2,3],[2,4],[3,4],[1,4]].map(([a,b]) => ({ source: ids[a], target: ids[b] })),
};
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.abort());
    await page.route('**/__interactions.json', r => r.fulfill({ json: graph }));
    await page.goto(`${base}/sidebar-workbench.html?graphSnapshot=/__interactions.json&graphEffects=none`);
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor();
    const presentation = () => canvas.evaluate(c => c.profilePresentation());
    await page.waitForTimeout(600);
    const initial = await presentation(), root = initial.nodes.find(n => n.id === ids[0]);
    await page.mouse.move(root.x, root.y);
    await page.waitForFunction(id => document.querySelector('.graph-renderer').dataset.hovered === id, ids[0]);
    await page.getByRole('region', { name: 'Quick look' }).waitFor();
    await page.waitForTimeout(1200);
    assert.equal((await presentation()).hovered, ids[0]);
    // The hovered point stays at its original footprint and remains clickable.
    await page.mouse.click(root.x, root.y);
    await page.waitForFunction(id => document.querySelector('.graph-renderer').dataset.selected === id, ids[0]);
    await page.waitForTimeout(1200);
    const committed = await page.evaluate(() => { window.dispatchEvent(new Event('sidebar:camera')); return JSON.parse(document.querySelector('.sidebar-presentation').textContent).committed; });
    assert.deepEqual(committed.selected, [ids[0]], 'click commits graph selection and opens the note');
    let scene = await presentation();
    const edge = (s, a, b) => s.edges.find(e => e.source === ids[a] && e.target === ids[b]);
    assert.equal(edge(scene, 0, 2).ink, 1, 'memory spokes remain visible');
    assert.equal(edge(scene, 2, 3).ink, 0, 'second-hop edge rests until inspected');
    const direct = scene.nodes.find(n => n.id === ids[2]);
    await page.mouse.move(direct.x, direct.y);
    await page.waitForFunction(id => document.querySelector('.graph-renderer').dataset.hovered === id, ids[2]);
    await page.waitForTimeout(1200);
    scene = await presentation();
    assert.equal(edge(scene, 2, 3).ink, 1, 'hover restores the direct-to-second-hop edge');
    assert.equal(edge(scene, 2, 4).ink, 1, 'hover restores all actual neighbor edges');
    await page.mouse.click(direct.x, direct.y);
    await page.waitForFunction(id => document.querySelector('.graph-renderer').dataset.selected === id, ids[2]);
    await page.waitForTimeout(1200);
    scene = await presentation();
    assert(edge(scene, 3, 4).ink > 0 && edge(scene, 3, 4).ink <= .06, 'neighbor edges remain as faint context');
    // Changing the theme after mount must recolor the ground, not leave a gray plane.
    await page.mouse.move(1439, 999);
    for (const [theme, expected] of [['default', [255,255,255]], ['dusk', [33,25,31]], ['phosphor', [211,224,213]]]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.waitForTimeout(1200);
      const png = await page.screenshot();
      const pixel = await page.evaluate(async url => {
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData((innerWidth - 8) * devicePixelRatio, 150 * devicePixelRatio, 1, 1).data].slice(0,3);
      }, `data:image/png;base64,${png.toString('base64')}`);
      assert(pixel.every((v,i) => Math.abs(v - expected[i]) <= 1), `theme ground ${theme}: ${pixel}`);
    }
    await page.mouse.click(1430, 150);
    await page.waitForFunction(() => document.querySelector('.graph-renderer').dataset.selected === '');
    assert.deepEqual(errors, []);
    console.log('PASS: hover preview, stationary-node click, committed selection, inspected/neighbor edges, blank reset, light/dark/colored theme background pixels');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
