/** Run against :5198; fabricated scenes exercise the actual NoteTab. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    // These scenes use fakeApi exclusively; never allow a real backend request.
    await page.route("**/api/**", route => route.abort());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
    const atlas = 'projection/entities/ent_00000000000000000001.md';
    await page.goto(`${base}/dev.html?c=briefings&s=ready&preview=1`);
    await page.locator('.briefing-summary').waitFor();
    const titles = await page.locator('.link-title').allTextContents();
    assert.deepEqual(titles, ['Atlas — September update', 'Maya Chen', 'Project notebook']);
    const longRow = page.locator('.source-link').first();
    assert.ok(await longRow.locator('.link-title').evaluate(el => el.scrollWidth > el.clientWidth));
    assert.ok((await longRow.boundingBox()).height < 60);
    await longRow.focus();
    await page.getByRole('tooltip').waitFor();
    assert.equal(await page.getByRole('tooltip').textContent(), titles[0]);
    await longRow.evaluate(el => el.blur());
    await page.mouse.move(500, 200);
    // Focus initialized the cursor; reset it for the complete j/k walk.
    await page.reload();
    await page.locator('.briefing-summary').waitFor();
    for (const title of titles) {
      await page.keyboard.press('j');
      assert.equal(await page.locator('.source-link.lk-on .link-title').textContent(), title);
    }
    // Names and descriptions share one clickable, inverted row.
    const row = page.locator('.source-link').filter({ hasText: 'Maya Chen' });
    assert.equal(await row.evaluate(el => {
      const title = el.querySelector('.link-title').getBoundingClientRect();
      const text = el.querySelector('.link-description').getBoundingClientRect();
      return text.left > title.right;
    }), true);
    await row.locator('.link-description').hover();
    await page.waitForTimeout(200);
    assert.equal(await row.evaluate(el => {
      const style = getComputedStyle(el);
      return style.backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(el.querySelector('.link-description')).color === style.color;
    }), true);
    assert.equal(await page.locator('[role="tooltip"]').count(), 0);
    await row.locator('.link-description').click();
    await page.waitForURL(/ent_00000000000000000002/);
    await page.keyboard.press('h');
    await page.waitForURL(/ent_00000000000000000001/);
    await page.locator('.briefing-summary').waitFor();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    assert.equal(await page.locator('.source-link.lk-on .link-title').textContent(), 'Project notebook');
    await page.locator('.source-link').nth(1).screenshot({ path: '/private/tmp/note-link-highlight.png' });
    await page.keyboard.press('Enter');
    await page.waitForURL(/#\/vault\/memory\/project.md/);
    await page.locator('.original-note').waitFor();
    await page.locator('.source-link').first().waitFor();
    await page.locator('.original-note summary').click();
    await page.keyboard.press('j');
    assert.equal(await page.locator('.source-link.lk-on .link-title').count(), 1);
    assert.equal(await page.locator('.original-note .lk-on').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.locator('.source-link').evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
    await page.screenshot({ path: '/private/tmp/note-briefing-mobile.png' });
    await page.goto(`${base}/dev.html?c=briefings&s=source&preview=1`);
    await page.locator('.briefing-summary').waitFor();
    assert.equal(await page.locator('.source-link').count(), 1);
    const sourceOpen = page.getByRole('button', { name: 'Open original source' });
    assert.match((await sourceOpen.textContent()).trim(), /O OPEN$/);
    assert.match(await sourceOpen.getAttribute('aria-keyshortcuts'), /^(Meta|Control)\+O$/);
    await page.goto(`${base}/dev.html?c=briefings&s=error&preview=1`);
    await page.locator('.retry').waitFor();
    assert.equal(await page.locator('.source-link').count(), 3);
    assert.equal(await page.locator('.link-description').count(), 0);
    await page.goto(`${base}/dev.html?c=briefings&s=many&preview=1`);
    await page.locator('.briefing-summary').waitFor();
    assert.equal(await page.locator('.source-link').count(), 14);
    assert.equal(await page.locator('.link-description').count(), 10);
    assert.equal(await page.locator('.remaining-start').count(), 1);
    const allTitles = await page.locator('.link-title').allTextContents();
    for (const title of allTitles) {
      await page.keyboard.press('j');
      assert.equal(await page.locator('.source-link.lk-on .link-title').textContent(), title);
    }
    await page.goto(`${base}/dev.html?c=briefings&s=streaming&preview=1`);
    await page.locator('.briefing-summary').waitFor();
    assert.equal(await page.locator('.briefing').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('.link-description').count(), 0);
    const previewOrder = await page.locator('.source-link').evaluateAll(rows => rows.map(row => row.dataset.path));
    await page.keyboard.press('j');
    const previewTarget = await page.locator('.source-link.lk-on .link-title').textContent();
    await page.locator('.briefing[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('.link-description').count(), 3);
    assert.deepEqual(await page.locator('.source-link').evaluateAll(rows => rows.map(row => row.dataset.path)), previewOrder);
    assert.equal(await page.locator('.source-link.lk-on .link-title').textContent(), previewTarget);
    // HUD layout, header actions, themes, and reduced motion.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${base}/dev.html?c=briefings&s=ready&preview=1&t=dusk`);
    await page.locator('.briefing-summary').waitFor();
    assert.equal(await page.locator('.note-ts').getAttribute('datetime'), '2026-08-26T16:46:00.000Z');
    assert.equal(await page.locator('.drawer').evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await page.locator('.briefing').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    const selectAction = page.getByRole('button', { name: 'Select connection' });
    assert.equal((await selectAction.textContent()).trim(), '↵ SELECT');
    const hud = await page.evaluate(() => {
      const row = document.querySelector('.source-link.lk-on');
      const sheet = document.querySelector('.sheet');
      const header = document.querySelector('.hud-header').getBoundingClientRect();
      const summary = document.querySelector('.briefing-summary').getBoundingClientRect();
      const list = document.querySelector('.source-links').getBoundingClientRect();
      return { contrast: getComputedStyle(row).color !== getComputedStyle(row).backgroundColor,
        radius: parseFloat(getComputedStyle(sheet).borderRadius), twoColumns: summary.right < list.left,
        headerAboveBody: header.bottom < summary.top, barVisible: !document.querySelector('#topbar').classList.contains('down') };
    });
    assert.ok(hud.contrast && hud.radius > 0 && hud.twoColumns && hud.headerAboveBody && hud.barVisible);
    await page.screenshot({ path: '/private/tmp/note-hud-dark.png' });
    // This note-only fixture has no Pilot create endpoint. Echo the local draft
    // so the keyboard handoff is exercised without a model or real backend.
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        if (String(input).endsWith('/api/pilot/chat/create')) {
          const { chat } = await import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/lib/pilotChat.svelte.ts')).name);
          const { id } = JSON.parse(init.body);
          return new Response(JSON.stringify(chat.sessions.find(s => s.id === id)), { headers: { 'content-type': 'application/json' } });
        }
        return original(input, init);
      };
    });
    // Shift-Enter starts a Pilot with the note, not the highlighted relationship.
    await page.keyboard.press('Shift+Enter');
    await page.getByRole('region', { name: 'Pilot text tab' }).waitFor();
    assert.match(page.url(), /session\/pilot-/);
    const seed = await page.evaluate(async () => {
      const { activeChat } = await import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/lib/pilotChat.svelte.ts')).name);
      return activeChat().seed;
    });
    assert.deepEqual(seed, [atlas]);
    await page.goto(`${base}/dev.html?c=briefings&s=ready&preview=1&t=dusk`);
    await page.locator('.briefing-summary').waitFor();
    await page.keyboard.press('j'); await page.keyboard.press('j');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }));
    // A focused header control owns Enter, without also following the link cursor.
    await page.locator('.discuss-shortcut').focus();
    await page.keyboard.press('Enter');
    assert.match(page.url(), /ent_00000000000000000001/);
    assert.equal(await page.locator('.discuss-shortcut').textContent().then(s => s.trim()), 'COPIED');
    await page.getByRole('button', { name: 'Select connection' }).click();
    await page.waitForURL(/ent_00000000000000000002/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.briefing-summary').waitFor();
    await page.screenshot({ path: '/private/tmp/note-hud-mobile.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: whole-row highlight and activation, Select HUD action, Shift-Enter Discuss, source Open shortcut, column spacing, truncated titles, stable PageRank order before/after generation, j/k/Enter, Markdown originals, source briefing, mobile wrapping, ten descriptions, remaining links, usable failure state; no runtime errors.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
