// The launcher is a single list in the production AppShell.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5218';
(async () => {
 const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/sidebar-workbench.html');
  await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
  await page.keyboard.press('j');
  const menu = page.locator('.workspace-menu');
  const rows = menu.locator('.menu-row');
  await menu.waitFor();
  assert.equal(await menu.locator('.memory-row.current').count(), 1);
  assert.equal(await page.locator('.workspace-parent, .submenu').count(), 0);
  const identities = await rows.evaluateAll(els => els.map(el => ({memory:el.dataset.workspaceId, agent:el.dataset.agentId})));
  let owner;
  for (const row of identities) {
   if (!row.agent) owner = row.memory;
   else assert.equal(row.memory, owner, 'each agent sits beneath its owning memory');
  }
  const memoryLeft = (await menu.locator('.memory-row .title').first().boundingBox()).x;
  const markerLeft = (await menu.locator('.agent-row .pilot-triangle').first().boundingBox()).x;
  assert(Math.abs(memoryLeft - markerLeft) < 1, 'visible agent marker aligns with memory title');
  assert(identities.some(row => row.agent), 'active agents visible without entering a submenu');
  for (let i = 1; i < identities.length; i++) {
   await page.keyboard.press('j');
   assert.equal(await rows.nth(i).getAttribute('aria-current'), 'true', 'J visits every memory and agent');
  }
  for (let i = identities.length - 2; i >= 0; i--) {
   await page.keyboard.press('k');
   assert.equal(await rows.nth(i).getAttribute('aria-current'), 'true', 'K visits every memory and agent');
  }
  assert.match(await menu.locator('.current .row-hints').textContent(), /Open.*Attach a pilot/s);
  await menu.getByRole('button', {name:'Field research',exact:true}).focus();
  const openedMemory = await menu.locator('.current').getAttribute('data-workspace-id');
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => decodeURIComponent(location.hash).includes(id), openedMemory);
  await page.waitForFunction(() => document.documentElement.dataset.sidebarTab === 'document');
  await menu.waitFor({state:'detached'});
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
  await menu.waitFor();
  assert.equal(await menu.locator('.current').getAttribute('data-workspace-id'), openedMemory, 'Escape restores the opened memory in the quick pick');
  await page.keyboard.press('Shift+Escape');
  assert.equal(await rows.count(), identities.length, 'archive on memory does nothing');
  const agent = menu.locator('.agent-row').first();
  const id = await agent.getAttribute('data-agent-id');
  await agent.focus();
  assert.match(await menu.locator('.current .row-hints').textContent(), /Open.*⇧Esc/s);
  assert.equal(await menu.locator('.current .archive-icon').count(), 1);
  await page.keyboard.press('Enter');
  await page.locator('.pilot-panel').waitFor();
  await page.keyboard.press('Escape'); await menu.waitFor();
  assert.equal(await menu.locator('.current').getAttribute('data-agent-id'), id, 'return restores selected agent');
  await page.evaluate(() => {
   const original = window.fetch.bind(window);
   window.restoreFetch = () => { window.fetch = original; };
   window.fetch = (input, init) => String(input).includes('/api/pilot/chat/stop-tree')
    ? Promise.resolve(new Response(JSON.stringify({error:'Archive unavailable'}), {status:503}))
    : original(input, init);
  });
  await page.keyboard.press('Shift+Escape');
  await menu.getByRole('alert').waitFor();
  assert.equal(await menu.locator('.current').getAttribute('data-agent-id'), id);
  await page.evaluate(() => window.restoreFetch());
  await page.keyboard.press('Shift+Escape');
  // Capture the transient confirmation in one browser turn; the row is removed
  // after its announcement, including a shorter reduced-motion interval.
  const archived = await page.waitForFunction(() => {
   const menu = document.querySelector('.workspace-menu');
   const hints = menu?.querySelector('.archived .row-hints')?.textContent;
   const status = menu?.querySelector('[role=status]')?.textContent;
   const animation = menu?.querySelector('.archived')?.getAnimations()[0];
   return hints?.includes('Archived') && status?.includes('archived') ? { hints, status, duration: animation?.effect?.getTiming().duration ?? 0, at: performance.now() } : null;
  });
  const confirmation = await archived.jsonValue();
  assert.match(confirmation.hints, /Archived/);
  assert.match(confirmation.status, /archived/);
  assert(confirmation.duration <= 150, 'archive animation lasts at most 150 ms');
  await page.waitForFunction(id => !document.querySelector('[data-agent-id="' + id + '"]'), id);
  assert.equal(await rows.count(), identities.length - 1);
  await menu.getByRole('button', {name:'Field research',exact:true}).focus();
  const memory = await menu.locator('.current').getAttribute('data-workspace-id');
  await page.evaluate(() => {
   const fetch = window.fetch;
   window.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes('/api/pilot/chat/create')) window.createdFixture = await response.clone().json();
    return response;
   };
  });
  await page.keyboard.press('Shift+Enter');
  await page.locator('.pilot-panel').waitFor();
  const context = await page.evaluate(async () => {
   const {chat} = await import('/src/lib/pilotChat.svelte.ts');
   return chat.sessions.find(s => s.id === chat.activeId).context;
  });
  assert.deepEqual(context, [memory], 'new agent attaches only the selected memory');
  await page.waitForFunction(() => window.createdFixture);
  assert((await page.evaluate(() => window.createdFixture.revision)) > 0, 'persisted creation must advance the optimistic revision');
  // Creation is a persisted server view, newer than the optimistic local draft.
  // Check category acceptance before a later draft save can mask a stale revision.
  await page.waitForFunction(async memory => (await import('/src/lib/pilotChat.svelte.ts')).activeChat()?.category?.memory === memory, memory);
  await page.locator('.pilot-panel [contenteditable=true]').fill('Flat launcher draft');
  await page.keyboard.press('Escape');
  await menu.waitFor();
  assert.equal(await menu.locator('.current').getAttribute('data-workspace-id'), memory);
  assert(await menu.locator('.current').getAttribute('data-agent-id'));
  await page.setViewportSize({width:390,height:400});
  await page.keyboard.press('G');
  const box = await menu.boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 400);
  const current = await menu.locator('.current').boundingBox();
  const scroll = await menu.locator('.menu-rows').boundingBox();
  assert(current.y >= scroll.y && current.y + current.height <= scroll.y + scroll.height + 1, 'keyboard selection scrolls into view');
  await page.screenshot({path:'/tmp/flat-agent-launcher.png'});
  assert.deepEqual(errors, []);
  console.log('PASS: flat launcher traversal, ownership, conversation return, archive failure/success, memory attachment, and narrow scrolling in AppShell');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
