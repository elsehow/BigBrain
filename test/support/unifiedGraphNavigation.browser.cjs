const { webkit, chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
  const browser = await (process.env.BROWSER === 'chromium' ? chromium.launch({ headless: true, channel: 'chrome' }) : webkit.launch({ headless: true }));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.abort());
    await page.goto(`${base}/sidebar-workbench.html?graphEffects=none`);
    const canvas = page.locator('.graph-renderer canvas'); await canvas.waitFor();
    const scene = () => canvas.evaluate(c => c.profilePresentation());
    const stats = () => canvas.evaluate(c => ({ ...c.profileStats }));
    const blank = () => canvas.evaluate(c => {
      const s = c.profilePresentation();
      for (let y = 150; y < 600; y += 70) for (let x = innerWidth - 160; x > 600; x -= 100)
        if (document.elementFromPoint(x, y) === c && s.nodes.every(n => !n.visible || Math.hypot(n.x - x, n.y - y) > 55)) return { x, y };
      throw Error('No blank point');
    });
    await page.waitForTimeout(1200);
    // Escape must reset manual framing even when selection is already empty.
    const homeCamera = (await scene()).camera;
    const homeBlank = await blank(); await page.mouse.move(homeBlank.x, homeBlank.y);
    await page.mouse.wheel(0, -200); await page.waitForTimeout(1200);
    assert((await scene()).camera.zoom > homeCamera.zoom);
    await page.keyboard.press('Escape'); await page.waitForTimeout(1200);
    const restoredHome = await scene();
    assert.equal(restoredHome.camera.manual, false);
    for (const key of ['x', 'y', 'zoom']) assert(Math.abs(restoredHome.camera[key] - homeCamera[key]) < .001, `Escape restores home ${key}`);
    await page.keyboard.press('j'); await page.waitForTimeout(1200);
    const selected = await page.locator('.graph-renderer').getAttribute('data-selected');
    const ground = await blank(); await page.mouse.move(ground.x, ground.y); await page.waitForTimeout(1200);
    const beforePan = await scene(), beforeStats = await stats();
    await page.mouse.down(); await page.mouse.move(ground.x + 70, ground.y + 35, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(1200);
    const panned = await scene();
    assert(panned.camera.manual); assert.equal(await page.locator('.graph-renderer').getAttribute('data-selected'), selected, 'pan does not blank-click the selection');
    assert(Math.abs((panned.camera.x - beforePan.camera.x) * beforePan.camera.zoom + 70) < .5);
    assert(Math.abs((panned.camera.y - beforePan.camera.y) * beforePan.camera.zoom + 35) < .5);
    assert.equal((await stats()).uploads, beforeStats.uploads, 'pan changes uniforms only');
    await page.waitForTimeout(300); assert.deepEqual((await scene()).camera, panned.camera, 'focus does not fight manual panning');

    // Wheel/pinch anchor the actual depth plane under the pointer.
    let node = (await scene()).nodes.find(n => n.id === selected);
    await page.mouse.move(node.x, node.y); await page.waitForTimeout(1200);
    node = (await scene()).nodes.find(n => n.id === selected); await page.mouse.move(node.x, node.y);
    const zoomBefore = await scene(), zoomStats = await stats();
    const zoomFrames = await canvas.evaluate(async (c, p) => {
      const read = () => { const s = c.profilePresentation(); return { camera: s.camera, node: s.nodes.find(n => n.id === p.id) }; };
      const frames = [read()];
      c.dispatchEvent(new WheelEvent('wheel', { clientX: p.x, clientY: p.y, deltaY: -180, bubbles: true, cancelable: true }));
      frames.push(read());
      for (let i = 0; i < 12; i++) { await new Promise(requestAnimationFrame); frames.push(read()); }
      return frames;
    }, node);
    assert.equal(zoomFrames[1].camera.zoom, zoomFrames[0].camera.zoom, 'wheel does not jump synchronously');
    assert(new Set(zoomFrames.map(f => f.camera.zoom)).size > 5, 'wheel zoom progresses over multiple frames');
    for (const f of zoomFrames) assert(Math.hypot(f.node.x - node.x, f.node.y - node.y) < 1, 'anchor stays fixed throughout zoom');
    await page.waitForTimeout(1200);
    let zoomed = await scene(), zoomNode = zoomed.nodes.find(n => n.id === selected);
    assert(zoomed.camera.zoom > zoomBefore.camera.zoom);
    assert(Math.hypot(zoomNode.x - node.x, zoomNode.y - node.y) < 1, 'wheel anchor includes node depth');
    const prevented = await canvas.evaluate((c, p) => {
      const e = new WheelEvent('wheel', { clientX: p.x, clientY: p.y, deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }); c.dispatchEvent(e); return e.defaultPrevented;
    }, zoomNode);
    await page.waitForTimeout(1200);
    const pinched = await scene(), pinchNode = pinched.nodes.find(n => n.id === selected);
    assert(prevented && pinched.camera.zoom < zoomed.camera.zoom, 'trackpad pinch is handled without browser zoom');
    assert(Math.hypot(pinchNode.x - node.x, pinchNode.y - node.y) < 1);
    assert.equal((await stats()).uploads, zoomStats.uploads, 'zoom does not upload scene state');

    // One dragged position drives its node, labels, ordinary and activity edges.
    const dragBefore = await scene(), dragStats = await stats(); node = dragBefore.nodes.find(n => n.id === selected);
    await page.mouse.move(node.x, node.y); await page.mouse.down();
    await page.mouse.move(node.x + 100, node.y - 80, { steps: 6 }); await page.waitForTimeout(100);
    const dragged = await scene(), dragNode = dragged.nodes.find(n => n.id === selected);
    assert(Math.hypot(dragNode.x - node.x - 100, dragNode.y - node.y + 80) < 1, 'lifted node follows the hand');
    assert.deepEqual(dragged.camera, dragBefore.camera, 'node drag does not pan or refocus');
    const otherBefore = dragBefore.nodes.find(n => n.id !== selected && n.visible);
    const other = dragged.nodes.find(n => n.id === otherBefore.id);
    assert(Math.hypot(other.x - otherBefore.x, other.y - otherBefore.y) < 1, 'unrelated node positions remain unchanged');
    assert((await stats()).positionUploads > dragStats.positionUploads);
    const shot = await page.screenshot();
    const pixel = await page.evaluate(async ({ url, point }) => {
      const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(Math.round(point.x * devicePixelRatio), Math.round(point.y * devicePixelRatio), 1, 1).data];
    }, { url: `data:image/png;base64,${shot.toString('base64')}`, point: dragNode });
    assert(pixel[0] < 160, `actual GPU node follows drag: ${pixel}`);
    await page.mouse.up(); await page.waitForTimeout(1200);
    assert.equal(await page.locator('.graph-renderer').getAttribute('data-selected'), selected, 'drag does not click/open the node');
    const released = (await scene()).nodes.find(n => n.id === selected);
    assert(Math.hypot(released.x - dragNode.x, released.y - dragNode.y) < 1);

    // Cancel capture, then keyboard navigation must regain smooth camera ownership.
    const ground2 = await blank(); await page.mouse.move(ground2.x, ground2.y); await page.mouse.down();
    await page.mouse.move(ground2.x + 25, ground2.y + 20);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.waitForTimeout(1200);
    assert.notEqual(await canvas.evaluate(c => getComputedStyle(c).cursor), 'grabbing');
    assert.equal((await scene()).camera.manual, false, 'Escape releases manual camera ownership');
    assert.equal((await scene()).hovered, null);
    assert.equal(await page.locator('.graph-renderer').getAttribute('data-selected'), '', 'Escape clears selection and returns home');
    await page.keyboard.press('j'); await page.waitForTimeout(80);
    assert.equal((await scene()).camera.manual, false);
    const focus = await page.locator('.graph-renderer').getAttribute('data-selected');
    await page.waitForTimeout(1200);
    const focused = (await scene()).nodes.find(n => n.id === focus);
    assert(focused.x >= 79 && focused.x <= 1361 && focused.y >= 79 && focused.y <= 921, 'keyboard focus reveals the node within the safe frame');

    // Fit eases both translation and zoom back from the manual view.
    const ground3 = await blank(); await page.mouse.move(ground3.x, ground3.y); await page.mouse.wheel(0, -200); await page.waitForTimeout(1200);
    const manualZoom = (await scene()).camera.zoom;
    await page.mouse.dblclick(ground3.x, ground3.y); await page.waitForTimeout(80);
    const fitting = await scene();
    assert.equal(await page.locator('.graph-renderer').getAttribute('data-selected'), '');
    assert.equal(fitting.camera.manual, false);
    await page.waitForTimeout(1200); const fitted = await scene();
    assert(fitting.camera.zoom < manualZoom && fitting.camera.zoom > fitted.camera.zoom, 'fit interpolates zoom rather than snapping');
    assert.equal(fitted.camera.manual, false);
    await page.setViewportSize({ width: 1200, height: 900 }); await page.waitForTimeout(1200);
    assert.equal(await canvas.evaluate(c => c.width), 2400);
    await page.screenshot({ path: '/tmp/unified-navigation.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: production-shell pan, depth-aware wheel/pinch, uniform-only camera moves, node dragging and GPU pixels, capture cancellation, keyboard handoff, smooth double-click fit and DPR2 resize');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
