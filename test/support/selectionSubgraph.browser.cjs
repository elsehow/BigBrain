// Synthetic graph in AppShell; no live vault requests or private artifacts.
const { chromium, webkit } = require('playwright-core');
const assert = require('node:assert/strict');
const style = process.env.SELECTION_STYLE || 'cloud';
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
    await page.goto(`${base}/sidebar-workbench.html?selectionSubgraph=1&selectionStyle=${style}&graphSnapshot=/__subgraph.json`);
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
      for (let hop = 0; hop < s.nodes.length; hop++) {
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
        assert(inside, 'only induced subgraph edges exist');
        if (!inside) assert.equal(edge.activity, 0);
      }
    };
    await page.waitForTimeout(500);
    const original = await scene();
    await page.evaluate(async id => (await import('/src/lib/store.svelte.ts')).gotoNote(id), ids[0]);
    await page.waitForTimeout(500); await expectMembers([0,1,2,3,4]);
    const focused = await scene();
    if (style === 'cloud') assert(focused.labels.some(l => l.opacity > .05 && !focused.view.selected.includes(l.id)), 'composed cloud keeps a neighborhood landmark label visible');
    assert(focused.nodes.length < original.nodes.length, 'disconnected nodes leave renderer topology');
    assert(focused.nodes.some(n => { const before = original.nodes.find(p => p.id === n.id); return Math.hypot(n.worldX - before.worldX, n.worldY - before.worldY) > 5; }), 'subset gets new world positions');
    const route = await page.evaluate(() => location.hash);
    const beforeHover = await scene();
    const second = beforeHover.nodes.find(n => n.id === ids[2]);
    await page.mouse.move(second.x, second.y); await page.waitForTimeout(500);
    await expectMembers([0,1,2,3,4]);
    const hovered = await scene();
    assert.equal(hovered.hovered, ids[2], 'hover identifies the pointed node');
    assert(hovered.labels.some(l => l.id === ids[2] && l.opacity > 0), 'hover shows its name');
    assert((await page.locator('.selection-path').innerText()).includes('Subgraph sample 0 → Subgraph sample 1 → Subgraph sample 2'), 'hover explains a real connecting path');
    assert.equal(hovered.nodes.find(n => n.id === ids[2]).inkOpacity, 1, 'hover restores full emphasis');
    assert.deepEqual(hovered.camera, beforeHover.camera, 'hover never zooms or pans');
    assert.deepEqual(hovered.nodes.map(n => [n.worldX, n.worldY, n.height]), beforeHover.nodes.map(n => [n.worldX, n.worldY, n.height]), 'hover never moves nodes');
    assert.equal(await page.getByRole('region', { name: 'Quick look' }).count(), 0, 'no hover preview');

    await page.mouse.move(1439, 999);
    const beforeKeyboard = await scene();
    await page.keyboard.press('j'); await page.waitForTimeout(600);
    const keyboard = await scene();
    assert(keyboard.hovered, 'real relationship-list keyboard cursor reaches renderer');
    assert.deepEqual(keyboard.camera, beforeKeyboard.camera, 'keyboard highlights without moving the camera');
    assert(keyboard.labels.some(l => l.id === keyboard.hovered && l.opacity > 0), 'keyboard names the focused node');
    assert.deepEqual(keyboard.view, beforeKeyboard.view, 'keyboard inspection preserves selection');
    assert.deepEqual(keyboard.nodes.map(n => [n.id, n.worldX, n.worldY]), beforeKeyboard.nodes.map(n => [n.id, n.worldX, n.worldY]), 'keyboard frames without rebuilding the subset');
    await page.mouse.move(1439, 998);
    await click(2, true); await expectMembers([0,1,2,3,4]);
    assert.equal(await page.evaluate(() => location.hash), route);
    assert.deepEqual((await scene()).view.selected.sort(), [ids[0],ids[2]].sort());
    await click(2); await expectMembers([0,1,2,3,4]);
    assert.deepEqual((await scene()).view.selected, [ids[2]], 'source selection ranks the whole connected graph');
    await page.keyboard.press('Escape'); await page.waitForTimeout(500);
    assert.deepEqual((await scene()).view.selected, []);
    assert((await scene()).nodes.find(n => n.id === ids[5]).visible, 'Escape restores disconnected overview memory');
    const homeCamera = (await scene()).camera;
    await page.mouse.move(1250, 400); await page.mouse.wheel(0, -500); await page.waitForTimeout(600);
    assert((await scene()).camera.manual, 'wheel gives manual camera control');
    await page.keyboard.press('Escape'); await page.waitForTimeout(600);
    assert.deepEqual((await scene()).camera, homeCamera, 'Escape with no selection restores the fitted home camera');
    await click(5); await expectMembers([5]);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.keyboard.press('Escape'); await page.waitForTimeout(1800);
    const start = await scene(), point = start.nodes.find(n => n.id === ids[0]);
    await page.mouse.click(point.x, point.y); await page.mouse.move(1439, 999);
    await page.waitForTimeout(150);
    const mid = await scene();
    await page.waitForTimeout(450);
    const end = await scene();
    assert(mid.nodes.some(n => { const target = end.nodes.find(p => p.id === n.id); return target && Math.hypot(n.worldX - target.worldX, n.worldY - target.worldY) > 1; }), 'selection animates world positions rather than only the camera');
    assert(end.nodes.find(n => n.id === ids[0]).height > end.nodes.find(n => n.id === ids[3]).height, 'relevance places seed ahead of memory landmarks');
    assert(end.nodes.length <= (style === 'cloud' ? 120 : 60));
    const restingEdges = end.edges.filter(e => e.ink > 0);
    assert(restingEdges.length <= Math.max(1, Math.round(end.nodes.length * (style === 'cloud' ? .45 : .2))), 'resting view has a sparse edge budget');
    const settled = end.nodes.map(n => [n.worldX, n.worldY]);
    await page.waitForTimeout(150);
    assert.deepEqual((await scene()).nodes.map(n => [n.worldX, n.worldY]), settled);
    await page.keyboard.press('j'); await page.waitForTimeout(600);
    const inspected = await scene();
    assert.deepEqual(inspected.camera, end.camera, 'subset keyboard inspection leaves camera stationary');
    assert.deepEqual(inspected.nodes.map(n => n.height), end.nodes.map(n => n.height), 'subset keyboard inspection leaves depth stationary');
    const row = page.getByText('Subgraph sample 1', { exact: true }).first();
    await row.hover(); await page.waitForTimeout(600);
    const rowHover = await scene();
    assert.equal(rowHover.hovered, ids[1], 'sidebar mouse hover highlights the matching graph node');
    assert(rowHover.labels.some(l => l.id === ids[1] && l.opacity > 0), 'sidebar hover names the graph node');
    assert.deepEqual(rowHover.camera, end.camera);
    await page.keyboard.press('Escape'); await page.waitForTimeout(1600);
    const overview = await scene();
    await page.keyboard.press('j'); await page.waitForTimeout(1200);
    const keyboardHome = await scene();
    const homeRow = page.locator('.workspace-menu .memory-row[data-workspace-id="memory/root.md"]');
    await homeRow.hover(); await page.waitForTimeout(1200);
    const homeMouse = await scene();
    assert(homeMouse.highlighted.includes(ids[0]), 'home mouse highlights its graph node');
    assert.deepEqual(homeMouse.nodes.map(n => n.height), keyboardHome.nodes.map(n => n.height), 'home mouse preserves keyboard depths');
    assert.equal(await page.getByRole('region', { name: 'Quick look' }).count(), 1, 'home mouse shows the preview tab');
    await page.keyboard.press('j'); await page.waitForTimeout(600);
    for (let i = 0; i < 6 && !(await scene()).view.selected.some(id => ids.includes(id)); i++) { await page.keyboard.press('j'); await page.waitForTimeout(600); }
    const overviewFocus = await scene();
    assert.deepEqual(await page.evaluate(async () => (await import('/src/lib/store.svelte.ts')).app.graphView.selected), [], 'home keyboard inspection does not commit a selection');
    assert.deepEqual(overviewFocus.nodes.map(n => [n.id,n.worldX,n.worldY]), overview.nodes.map(n => [n.id,n.worldX,n.worldY]), 'home keyboard inspection keeps complete topology and layout');
    assert(overviewFocus.view.selected.length, 'home keyboard cursor previews a graph node');
    assert.notDeepEqual(overviewFocus.camera, overview.camera, 'home keyboard preview retains the original pan');
    assert(overviewFocus.nodes.some(n => n.height !== overview.nodes.find(p => p.id === n.id).height), 'home keyboard inspection changes depth');
    await page.waitForTimeout(800);
    const held = await scene();
    await page.mouse.move(1439, 999); await page.waitForTimeout(700);
    const moved = await scene();
    assert.deepEqual(moved.view, held.view, 'incidental mouse movement preserves the keyboard view');
    assert.deepEqual(moved.camera, held.camera, 'incidental mouse movement preserves keyboard camera');
    assert.deepEqual(moved.nodes.map(n => n.height), held.nodes.map(n => n.height), 'incidental mouse movement preserves keyboard depth');
    await homeRow.hover(); await page.waitForTimeout(800);
    const mouseOverOther = await scene();
    assert.deepEqual(mouseOverOther.view, held.view, 'hovering another row does not replace the keyboard view');
    assert.deepEqual(mouseOverOther.camera, held.camera, 'hovering another row preserves camera');
    assert.deepEqual(mouseOverOther.nodes.map(n => n.height), held.nodes.map(n => n.height), 'hovering another row preserves depths');
    assert(mouseOverOther.highlighted.includes(ids[0]), 'hovered row still highlights');
    // Exercise a recessed memory on the held keyboard view: its domain hover
    // treatment used to lift the node and move it away from the pointer.
    await page.mouse.move(1439, 999); await page.waitForTimeout(700);
    const beforePointer = await scene();
    const target = beforePointer.nodes.find(n => n.visible && n.id !== beforePointer.view.selected[0] && n.x > 580 && n.x < 1400 && n.y > 100 && n.y < 700);
    assert(target, 'fixture has an unobstructed node to inspect');
    await page.mouse.move(target.x, target.y); await page.waitForTimeout(800);
    const afterPointer = await scene(), pinned = afterPointer.nodes.find(n => n.id === target.id);
    assert.equal(afterPointer.hovered, target.id, 'pointer retains its graph target');
    assert.equal(pinned.height, target.height, 'hover pins the target at its existing depth');
    assert(Math.hypot(pinned.x - target.x, pinned.y - target.y) < .5, 'hover target stays under the pointer');
    await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
    assert.deepEqual((await scene()).view.selected, [], 'Escape explicitly clears the held keyboard view');
    assert.equal(await page.locator('.graph-renderer canvas').count(), 1);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine.name()} ${style}: real shell, relative importance, bounded topology, relayout, animated transition, stationary hover labels, Shift union, source root, isolated root, Escape`);
  } finally { await browser.close(); }
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
