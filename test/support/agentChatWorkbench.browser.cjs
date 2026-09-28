/** Real panel/graph, fabricated workbench API; no live agent or vault writes. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], escaped = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', r => { escaped.push(r.request().url()); return r.fulfill({ status: 500, json: { error: 'Workbench API escaped' } }); });
  await page.addInitScript(() => {
   window.agentDotOffsets = [];
   const stroke = CanvasRenderingContext2D.prototype.stroke;
   CanvasRenderingContext2D.prototype.stroke = function(...args) {
    if (this.getLineDash().join(',') === '1,6') { window.agentDotOffsets.push(this.lineDashOffset); if (window.agentDotOffsets.length > 100) window.agentDotOffsets.shift(); }
    return stroke.apply(this, args);
   };
  });
  const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
  const panel = page.getByRole('region', { name: 'Worker monitor' });
  const visit = async (scene, preview = true) => {
   await page.goto(`${base}/dev.html?c=agent+chat&s=${scene}${preview ? '&preview=1' : ''}`);
   if (scene === 'pilot-stop') await page.getByRole('region', { name: 'Pilot conversation' }).waitFor();
   else await panel.getByText(scene.startsWith('quick-') ? 'Add table export to the ATLAS demo' : 'Arbor summary', { exact: true }).waitFor();
  };
  const state = async text => { await page.waitForFunction(t => document.querySelector('.worker-panel [role=status]')?.textContent.startsWith(t), text); };
  await visit('running'); await state('working');
  assert.equal(await panel.locator('.user-label').first().textContent(), 'Pilot');
  await page.waitForFunction(() => new Set(window.agentDotOffsets).size > 3);
  assert.ok((await page.evaluate(() => window.agentDotOffsets)).some(x => x < 0));
  await panel.getByLabel('Message worker').fill('Keep uncertain attribution separate.');
  await panel.getByRole('button', { name: '↵ Send', exact: true }).click();
  await panel.getByText('Keep uncertain attribution separate.', { exact: true }).waitFor();
  assert.equal(await panel.locator('.message.user').filter({ hasText: 'Keep uncertain attribution separate.' }).locator('.user-label').textContent(), 'You');
  await page.getByRole('button', { name: 'Finish turn', exact: true }).click(); await state('Turn finished');
  await panel.getByRole('button', { name: 'Arbor research — summary' }).waitFor();
  await panel.getByRole('button', { name: 'Open terminal' }).click();
  assert.match(await page.getByLabel('Simulated actions').textContent(), /no terminal launched/);
  assert.equal(await panel.getByRole('button', { name: 'Back to Pilot' }).count(), 0);
  await panel.getByRole('button', { name: 'Open terminal' }).focus();
  await page.keyboard.press('h');
  await page.getByRole('region', { name: 'Pilot conversation' }).waitFor();
  assert.match(await page.getByLabel('Simulated actions').textContent(), /Pilot selected/);
  await page.locator('body').click({ position: { x: 4, y: 4 } }); await page.keyboard.press('l');
  await panel.waitFor();
  await page.getByRole('button', { name: 'Reset scene' }).click(); await state('working');
  const standard = (await panel.boundingBox()).height;
  await panel.getByLabel('Message worker').focus();
  await page.keyboard.press('Shift+ArrowUp'); await page.waitForTimeout(300);
  assert.ok((await panel.boundingBox()).height > standard + 150);
  await page.keyboard.press('Shift+ArrowDown'); await page.waitForTimeout(300);
  assert.ok(Math.abs((await panel.boundingBox()).height - standard) < 2, JSON.stringify({ standard, after: await panel.boundingBox(), expanded: await panel.getByRole('button', { name: 'Expand text tab' }).getAttribute('aria-pressed') }));
  await page.keyboard.press('Shift+Escape'); await state('interrupted');
  await page.getByRole('button', { name: 'Reset scene' }).click(); await state('working');
  await panel.getByRole('button', { name: 'Open terminal' }).focus(); await page.keyboard.press('Meta+o');
  assert.match(await page.getByLabel('Simulated actions').textContent(), /no terminal launched/);
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Open agent', exact: true }).click(); await state('working');
  await visit('question'); await state('Needs input');
  await panel.getByRole('button', { name: 'Direct involvement only', exact: true }).click();
  await panel.getByRole('button', { name: 'Send answer' }).click(); await state('working');
  await visit('approval');
  await panel.getByRole('button', { name: 'Decline', exact: true }).click(); await state('working');
  await panel.getByText('decline', { exact: true }).waitFor();
  await visit('terminal'); await state('terminal');
  await panel.getByLabel('Message worker').fill('Continue');
  await panel.getByRole('button', { name: '↵ Send', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'owned by its terminal' }).waitFor();
  await page.getByRole('button', { name: 'Return to app' }).click(); await state('Turn finished');
  await visit('disconnected');
  await panel.getByRole('alert').filter({ hasText: 'Worker connection unavailable' }).waitFor();
  assert.ok(await panel.locator('.message').count() >= 2);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await panel.getByRole('alert').waitFor({ state: 'detached' });
  await visit('pilot-stop');
  const pilotPanel = page.getByRole('region', { name: 'Pilot conversation' });
  await page.keyboard.press('Shift+Escape');
  const warning = pilotPanel.locator('header').getByRole('alert');
  await warning.waitFor(); assert.match(await warning.textContent(), /Shift-Esc again to confirm/);
  assert.doesNotMatch(await page.getByLabel('Simulated actions').textContent(), /Stopped Pilot/);
  await page.screenshot({ path: '/private/tmp/pilot-stop-warning.png' });
  await warning.getByRole('button', { name: 'Cancel' }).click(); await warning.waitFor({ state: 'detached' });
  await page.keyboard.press('Shift+Escape'); await warning.waitFor();
  await page.keyboard.press('Shift+Escape'); await pilotPanel.waitFor({ state: 'detached' });
  assert.match(await page.getByLabel('Simulated actions').textContent(), /Stopped Pilot and agent session/);
  await page.getByRole('button', { name: 'Open agent', exact: true }).click(); await state('interrupted');
  for (const [scene, expected] of [['starting', 'starting'], ['done', 'Turn finished'], ['failed', 'failed'], ['stopped', 'interrupted'], ['long', 'working']]) {
   await visit(scene); await state(expected);
  }
  await visit('quick-log');
  assert.equal(await panel.locator('.user-label').first().textContent(), 'Pilot');
  assert.equal(await panel.locator('aside').count(), 0);
  assert.equal(await panel.locator('.log-entry').count(), 6);
  assert.match(await panel.locator('.log-entry').last().textContent(), /Nothing is committed, merged, or deployed/);
  await panel.getByRole('button', { name: 'Expand text tab' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/private/tmp/agent-quick-log.png' });
  await page.getByRole('button', { name: 'Show imperfect summaries' }).click();
  assert.equal(await panel.locator('.log-entry').count(), 5);
  assert.match(await panel.locator('.log-entry').nth(1).textContent(), /formatter helper/);
  await page.getByRole('button', { name: 'Show target summaries' }).click();
  await page.getByRole('button', { name: 'Replay log', exact: true }).click();
  await panel.getByRole('status', { name: 'Quick is summarizing' }).waitFor();
  assert.equal(await panel.locator('.log-entry').count(), 0);
  assert.equal(await panel.locator('.raw-entry').count(), 1); // no future progress during replay
  await page.waitForFunction(() => document.querySelectorAll('.log-entry').length === 1);
  await page.getByRole('button', { name: 'Show complete log' }).click();
  assert.equal(await panel.locator('.log-entry').count(), 6);
  assert.equal(await panel.getByRole('status', { name: 'Quick is summarizing' }).count(), 0);
  await panel.locator('.raw-log summary').click();
  await panel.getByText('The output schema is pinned and the demo page rebuilt.', { exact: false }).waitFor();
  await visit('quick-summarizing');
  await panel.getByRole('status', { name: 'Quick is summarizing' }).waitFor();
  assert.equal(await panel.locator('.log-entry').count(), 3);
  for (const strategy of ['delta', 'full']) {
   await visit(`quick-goal-${strategy}`);
   assert.equal(await panel.locator('.log-entry').count(), 6);
   assert.equal(await panel.locator('.user-label').first().textContent(), 'Pilot');
   assert.match(await panel.locator('.user-text').textContent(), /Keep missing values distinct from zero/);
   assert.match(await page.getByLabel('Agent scene controls').textContent(), /contains deliberate errors/);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await visit('long');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/private/tmp/agent-chat-narrow.png' });
  assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  // Keyed scene switches restore the prior mock, without stacking interceptors.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await visit('running', false);
  await page.getByRole('button', { name: 'Needs an answer', exact: true }).click(); await state('Needs input');
  await page.getByRole('button', { name: 'Turn finished', exact: true }).click(); await state('Turn finished');
  await page.getByRole('button', { name: 'Running', exact: true }).click(); await state('working');
  await page.getByLabel('dark', { exact: true }).check();
  await page.screenshot({ path: '/private/tmp/agent-chat-workbench.png' });
  assert.deepEqual(errors, []); assert.deepEqual(escaped, []);
  console.log('PASS agent workbench: lifecycle states, directed dots, follow-up, question, approval, stop, terminal safety, reconnect, scene switching and narrow layout; zero network API calls');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
