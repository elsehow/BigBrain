/** Fabricated mail and Pilot state only; never reaches a real account or model. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5208';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const scene = async (name, theme = '') => {
      await page.goto(`${base}/dev.html?c=notifications&s=${name}&preview=1${theme ? `&t=${theme}` : ''}`);
      await page.getByRole('region', { name: 'Notification center workbench' }).waitFor();
    };
    const bell = () => page.getByRole('button', { name: /^Notifications(?:,|$)/ });
    const unread = () => page.getByRole('button', { name: /^Select all \d+ unread sources$/ });
    await scene('overview');
    await page.getByRole('dialog', { name: 'Notifications', exact: true }).waitFor();
    const dimensions = await page.locator('.chrome-actions > button, .notification-anchor > button').evaluateAll(es => es.map(e => {
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      return { x: r.x, width: r.width, height: r.height, radius: s.borderRadius, bg: s.backgroundColor };
    }));
    assert.equal(dimensions.length, 3);
    assert.ok(dimensions[0].x < dimensions[1].x && dimensions[1].x < dimensions[2].x);
    for (const d of dimensions) assert.deepEqual([d.width, d.height, d.radius, d.bg], [40, 40, dimensions[2].radius, dimensions[2].bg]);
    await page.getByRole('checkbox', { name: 'Unread messages exist' }).uncheck();
    assert.equal(await unread().count(), 1);
    assert.equal(await unread().isDisabled(), true);
    assert.equal((await page.getByRole('button', { name: 'Settings', exact: true }).boundingBox()).x, dimensions[2].x);
    await page.getByRole('checkbox', { name: 'Unread messages exist' }).check();
    await bell().click();
    await page.getByRole('button', { name: 'Mark all seen' }).click();
    assert.equal(await bell().getAttribute('aria-label'), 'Notifications');
    assert.match(await page.getByRole('dialog', { name: 'Notifications', exact: true }).textContent(), /2 Pilots need you/);
    await page.locator('.notice-open').first().click();
    await page.getByRole('region', { name: 'Pilot notification conversation' }).waitFor();
    assert.equal(await page.locator('.message-target').getAttribute('data-message-id'), 'question-1');
    await page.getByRole('button', { name: 'Thursday', exact: true }).click();
    assert.match(await page.getByRole('region', { name: 'Pilot notification conversation' }).textContent(), /Answered/);
    await bell().click();
    assert.match(await page.getByRole('dialog', { name: 'Notifications', exact: true }).textContent(), /1 Pilot needs you/);
    assert.equal(await page.getByRole('button', { name: /Snooze/i }).count(), 0);
    assert.equal(await page.getByRole('img', { name: 'Pilot working', exact: true }).count(), 1);
    await page.getByRole('checkbox', { name: 'Research Pilot working' }).uncheck();
    await bell().click();
    assert.equal(await page.getByRole('img', { name: 'Pilot working', exact: true }).count(), 0);
    assert.match(await page.getByRole('dialog', { name: 'Notifications', exact: true }).textContent(), /1 Pilot needs you/);
    await page.getByRole('button', { name: 'Dismiss Reading group', exact: true }).click();
    assert.equal(await page.locator('.notice-open').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog', { name: 'Notifications', exact: true }).count(), 0);
    await unread().click();
    assert.equal(JSON.parse(await page.getByLabel('Selected graph sources').textContent()).length, 7);
    await page.locator('.briefing-summary').filter({ hasText: 'Two decisions stand out' }).waitFor();
    assert.equal(await page.locator('.source-list').count(), 0);
    await page.screenshot({ path: '/private/tmp/attention-unread-tab.png', animations: 'disabled' });
    await page.keyboard.press('Shift+Enter');
    const triage = page.getByRole('region', { name: 'Unread triage Pilot' });
    await triage.waitFor();
    assert.match(await triage.textContent(), /7 sources in context/);
    await page.getByRole('textbox', { name: 'Message triage Pilot' }).fill('Help me triage these.');
    await page.getByRole('button', { name: 'Send triage message' }).click();
    await page.getByRole('button', { name: 'Mark these messages read' }).click();
    await page.getByRole('status').filter({ hasText: '7 messages marked read in Gmail.' }).waitFor();
    assert.equal(await unread().count(), 1);
    assert.equal(await unread().isDisabled(), true);
    await page.getByRole('button', { name: 'Close triage' }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByRole('button', { name: 'Change one in Gmail' }).click();
    await page.getByRole('button', { name: 'Select all 1 unread sources', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Change one in Gmail' }).click();
    assert.equal(await unread().count(), 1);
    assert.equal(await unread().isDisabled(), true);

    await scene('failure'); await unread().click(); await page.keyboard.press('Shift+Enter');
    await page.getByRole('textbox', { name: 'Message triage Pilot' }).fill('Please triage.');
    await page.getByRole('button', { name: 'Send triage message' }).click();
    await page.getByRole('button', { name: 'Mark these messages read' }).click();
    await page.getByRole('alert').first().waitFor();
    assert.equal(await unread().getAttribute('aria-label'), 'Select all 7 unread sources');
    assert.equal(JSON.parse(await page.getByLabel('Selected graph sources').textContent()).length, 7);

    await scene('quiet');
    assert.equal(await bell().getAttribute('aria-label'), 'Notifications');
    await bell().click();
    assert.match(await page.getByRole('dialog', { name: 'Notifications', exact: true }).textContent(), /You’re caught up/);
    assert.match(await page.locator('.selection-summary').textContent(), /working with its agent/);

    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await scene('long', width === 390 ? 'dusk' : '');
      const popup = page.getByRole('dialog', { name: 'Notifications', exact: true });
      await popup.waitFor();
      const box = await popup.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `dropdown fits ${width}px: ${JSON.stringify(box)}`);
      const overflow = await page.locator('.notification-scroll').evaluate(el => el.scrollHeight > el.clientHeight);
      assert.equal(overflow, true);
      assert.equal(await page.locator('.notice-text').evaluateAll(es => es.every(el => el.getBoundingClientRect().right <= el.closest('.notification-panel').getBoundingClientRect().right)), true, `notification text wraps within ${width}px`);
      assert.equal(await page.locator('.attention-workbench').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      if (width === 390) await page.screenshot({ path: '/private/tmp/attention-mobile-dark.png', animations: 'disabled' });
      await unread().click();
      await page.locator('.briefing-summary').filter({ hasText: 'Two decisions stand out' }).waitFor();
      const tab = await page.getByRole('region', { name: 'Selected sources text tab' }).boundingBox();
      assert.ok(tab.x >= 0 && tab.x + tab.width <= width && tab.y + tab.height < 900);

    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await scene('overview');
    await page.getByRole('dialog', { name: 'Notifications', exact: true }).waitFor();
    await page.screenshot({ path: '/private/tmp/attention-overview.png', animations: 'disabled' });
    assert.deepEqual(errors, []);
    console.log('Notification workbench: toolbar geometry, independent unread toggle, seen/answered/dismissed states and independent Pilot activity, exact-message navigation, graph selection, Shift–Enter triage, provider read-state changes, failure handling, and four viewport widths passed.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
