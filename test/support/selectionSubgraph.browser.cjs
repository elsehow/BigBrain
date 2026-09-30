// Synthetic graph in AppShell; no live vault requests or private artifacts.
const { chromium, webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:5243';
const ids = ['memory/root.md', 'sources/first.md', 'sources/second.md', 'memory/third.md', 'sources/fourth.md', 'memory/island.md'];
const links = [[0,1],[1,2],[2,3],[3,4]];
const graph = {
  nodes: ids.map((id, i) => ({ id, path: id, title: `Subgraph sample ${i}`, group: id.startsWith('memory') ? 'memory' : 'source', degree: 2 })),
  edges: links.map(([a,b]) => ({ source: ids[a], target: ids[b] })),
};
(async () => {
 for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.abort());
    await page.route(url => url.pathname === '/__subgraph.json', r => r.fulfill({ json: graph }));
    await page.goto(`${base}/sidebar-workbench.html?selectionSubgraph=1&graphSnapshot=/__subgraph.json`);
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor();
    const scene = () => canvas.evaluate(c => c.profilePresentation());
    await page.waitForFunction(() => document.querySelector('canvas')?.profilePresentation?.().nodes.length >= 6);
    const click = async (i, shift = false) => {
      const p = (await scene()).nodes.find(n => n.id === ids[i]);
      await page.mouse.move(p.x, p.y);
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.click(p.x, p.y);
      if (shift) await page.keyboard.up('Shift');
      await page.mouse.move(1439, 999);
      await page.waitForTimeout(500);
    };
    const expectMembers = async members => {
      const s = await scene();
      assert.deepEqual(s.nodes.filter(n => n.visible && ids.includes(n.id)).map(n => n.id).sort(), members.map(i => ids[i]).sort());
      const expected = new Set(s.view.selected);
      let frontier = [...expected];
      for (let hop = 0; hop < 2; hop++) {
        const next = [];
        for (const id of frontier) for (const e of s.edges) {
          const neighbor = e.source === id ? e.target : e.target === id ? e.source : null;
          if (neighbor && !expected.has(neighbor)) { expected.add(neighbor); next.push(neighbor); }
        }
        frontier = next;
      }
      assert.deepEqual(s.nodes.filter(n => n.visible).map(n => n.id).sort(), [...expected].sort());
      for (const edge of s.edges) {
        const inside = expected.has(edge.source) && expected.has(edge.target);
        assert.equal(edge.ink > 0, inside, 'only induced subgraph edges have ink');
        if (!inside) assert.equal(edge.activity, 0);
      }
    };
    await click(0); await expectMembers([0,1,2]);
    const route = await page.evaluate(() => location.hash);
    const second = (await scene()).nodes[2];
    await page.mouse.move(second.x, second.y); await page.waitForTimeout(500);
    await expectMembers([0,1,2]);
    await click(2, true); await expectMembers([0,1,2,3,4]);
    assert.equal(await page.evaluate(() => location.hash), route);
    assert.deepEqual((await scene()).view.selected.sort(), [ids[0],ids[2]].sort());
    await click(2); await expectMembers([0,1,2,3,4]);
    assert.deepEqual((await scene()).view.selected, [ids[2]], 'source selection also reveals two hops');
    await page.keyboard.press('Escape'); await page.waitForTimeout(500);
    assert.deepEqual((await scene()).view.selected, []);
    assert((await scene()).nodes[5].visible, 'Escape restores disconnected overview memory');
    await click(5); await expectMembers([5]);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine.name()}: real shell, two hops, hidden third hop, hover boundary, Shift union, source root, isolated root, Escape`);
  } finally { await browser.close(); }
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
