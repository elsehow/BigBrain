// Run the sidebar workbench, then SIDEBAR_PREVIEW_URL=http://127.0.0.1:5217 node test/support/hoverStable.browser.cjs.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    let storeUrl, chatUrl;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {
      if (r.url().includes('/src/lib/store.svelte.ts')) storeUrl = r.url();
      if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url();
    });
    await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5217'}/sidebar-workbench.html`);
    await page.locator('.lg-wrap').waitFor();
    await page.waitForTimeout(1800);
    const presentation = () => page.evaluate(() => {
      window.dispatchEvent(new Event('sidebar:camera'));
      return JSON.parse(document.querySelector('.sidebar-presentation').textContent);
    });
    await page.evaluate(async url => (await import(url)).gotoNote('memory/project.md'), storeUrl);
    await page.waitForTimeout(1800);
    const initial = await presentation();
    assert(initial.nodes.filter(n => n.id.startsWith('pilot-')).every(n => n.visible && n.height === 80), 'all pilots stay on the front layer beside a selected memory');
    const root = initial.nodes.find(n => n.id === 'memory/project.md');
    const target = initial.nodes.find(n => root.neighbors.includes(n.id) && n.visible && n.x > 580 && n.y > 60 && n.y < 800);
    assert(target, JSON.stringify({root, neighbors: initial.nodes.filter(n => root.neighbors.includes(n.id))}));
    await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(300);
    assert.equal((await presentation()).hover, target.id);
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(target.x + (i % 2), target.y);
      await page.waitForTimeout(150);
      const state = await presentation(), node = state.nodes.find(n => n.id === target.id);
      assert.equal(state.hover, target.id, 'small pointer movements retain the hovered neighbor');
      assert(Math.hypot(node.x - target.x, node.y - target.y) < 1, 'hovered node stays in place');
      assert.equal(await page.getByRole('region', { name: 'Quick look' }).count(), 1);
    }
    await page.keyboard.press('Escape');
    await page.mouse.move(1400, 950);
    await page.waitForTimeout(1800);
    const id = 'pilot-11111111111111111111111111111111';
    const pilot = (await presentation()).nodes.find(n => n.id === id);
    await page.mouse.move(pilot.x, pilot.y);
    await page.waitForTimeout(600);
    const hoveredPilot = (await presentation()).nodes.find(n => n.id === id);
    assert.equal((await presentation()).hover, id);
    assert.equal(hoveredPilot.height, 80);
    assert(Math.hypot(hoveredPilot.x - pilot.x, hoveredPilot.y - pilot.y) < 1, 'pilot does not rise or move on hover');
    assert.equal(await page.getByRole('region', { name: 'Quick look' }).count(), 0, 'pilot hover never renders a note browser');
    await page.mouse.click(pilot.x, pilot.y);
    await page.locator('.pilot-panel').waitFor();
    assert(page.url().endsWith(`/session/${id}`));
    // An ingested source link must take the same chat route immediately.
    await page.evaluate(async ({ storeUrl, chatUrl, id }) => {
      const { chat } = await import(chatUrl);
      chat.sessions.find(s => s.id === id).ingestions = [{ through: 2, sourceId: 'pilot-source', insertionId: 'ins_fixture', path: 'sources/pilot-chat.md' }];
      (await import(storeUrl)).gotoNote('sources/pilot-chat.md');
      if (location.hash !== `#/session/${id}`) throw new Error('Pilot alias opened a note route');
    }, { storeUrl, chatUrl, id });
    await page.locator('.pilot-panel').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: selected-neighbor hover stays anchored with stable quick look; pilot hover has no browser and clicks/source links open chat.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
