// Production AppShell with an in-memory Connected Agent. No vault or agent process.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.stack));
    await page.addInitScript(() => {
      window.connectedActions = [];
      window.addEventListener('workbench-connected-action', e => window.connectedActions.push(e.detail));
    });
    const agents = page.getByRole('button', {name:'Agents', exact:true});
    const revealAgents = async () => {
      const box = await agents.boundingBox();
      assert(box, 'Agents trigger is laid out');
      // Reveal through pointer input, then retain keyboard focus while the
      // software-rendered CI browser performs its click actionability checks.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await agents.focus();
    };
    await page.goto(`${base}/sidebar-workbench.html?connected-agent=waiting`);
    // Exercise the idle state too: CI can finish compiling after the toolbar hides.
    await page.waitForFunction(() => document.documentElement.dataset.sidebarToolbar === 'false');
    await revealAgents();
    // Focus keeps the toolbar actionable even after its idle data flag resets.
    // The normal click below verifies visibility and pointer actionability.
    await page.getByRole('button', {name:'Agents', exact:true}).click();
    const row = page.locator('[data-pilot="work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]');
    const filter=page.getByRole('button',{name:'Show orchestrations',exact:true});
    assert.equal(await filter.getAttribute('aria-pressed'),'false');
    assert.equal(await filter.getAttribute('aria-keyshortcuts'),null);
    assert.equal(await row.count(),0,'orchestrations start hidden');
    await filter.click();await row.waitFor();
    await filter.focus();await page.keyboard.press('Enter');
    assert.equal(await row.count(),0,'keyboard activation toggles without opening a conversation');
    await page.keyboard.press('Space');await row.waitFor();
    assert.equal(await row.locator('svg').getAttribute('data-agent-state'), 'waiting');
    assert(await row.locator('svg rect').count() > 0, 'agent sessions use the square glyph');
    await row.click();
    const panel = page.getByRole('region', { name: 'Agent session conversation' });
    await panel.waitFor();
    await page.keyboard.press('h');
    await panel.waitFor({state:'hidden'});
    const handoff = page.getByRole('button', {name:'Open agent: Atlas implementation · Needs attention',exact:true});
    await handoff.waitFor();
    assert.equal(await handoff.locator('svg').getAttribute('data-agent-state'),'waiting');
    await handoff.click();
    await panel.waitFor();
    await panel.getByText('Task access and working folder', {exact:true}).click();
    const access=panel.getByRole('region',{name:'Project access request'});
    await access.waitFor();
    assert.match(await access.textContent(),/Edits, local deletion, and commands/);
    await access.getByRole('button',{name:'Allow for this task',exact:true}).click();
    await access.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(() => window.connectedActions), ['/api/pilot/work/approve']);
    assert.match(await panel.getByRole('status').textContent(), /Working/);
    assert.equal(await panel.getByRole('button', {name:/Open in terminal/}).count(),0);
    await page.screenshot({path:'/tmp/pi-worker-authorized.png'});
    await page.keyboard.press('Escape');
    await panel.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(() => window.connectedActions), ['/api/pilot/work/approve'], 'leaving the tab never stops work');
    await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
    await revealAgents();
    await agents.click(); await row.click(); await panel.waitFor();
    await panel.getByRole('button', {name:'Interrupt', exact:true}).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent session conversation"] [role="status"]')?.textContent.includes('Interrupted'));
    await panel.getByRole('button', {name:'Back to Pilot', exact:true}).click();
    await panel.waitFor({state:'hidden'});
    await page.locator('.pilot-panel').waitFor();
    await page.getByRole('button',{name:'Open agent: Atlas implementation · Interrupted',exact:true}).waitFor();
    await page.getByRole('button',{name:'Archive Pilot',exact:true}).click();
    await page.locator('.pilot-panel').waitFor({state:'hidden'});
    // Archiving closes the chat before its final goHome callback closes the shell.
    await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
    await revealAgents();
    await page.getByRole('button',{name:'Agents',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:/Atlas planning.*archived/}).count(),0,'archived pilots start hidden');
    assert.equal(await row.count(),0,'archived orchestrations stay hidden even when orchestrations are enabled');
    await page.getByRole('button',{name:'Show archived',exact:true}).click();
    await page.getByRole('button',{name:/Atlas planning.*archived/}).waitFor();
    await filter.click();assert.equal(await row.count(),0);await page.getByRole('button',{name:/Atlas planning.*archived/}).waitFor();await filter.click();
    await row.getByText('Archived',{exact:true}).waitFor();
    assert.equal(await row.locator('svg').getAttribute('data-agent-state'),'stopped');
    await row.click(); await panel.waitFor();
    assert.match(await panel.getByRole('status').textContent(),/Archived/);
    assert.equal(await panel.getByRole('button',{name:/Open in terminal/}).count(),0);
    await page.keyboard.press('h');
    await page.locator('.pilot-panel').waitFor();
    assert.equal(await page.getByRole('button',{name:/Open agent: Atlas implementation/}).count(),0,'archived orchestrations stay in history, not the active handoff strip');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.pilot-panel').waitFor({state:'hidden'});
    await page.mouse.move(100, 50);
    await page.getByRole('button', {name:'Settings', exact:true}).click();
    await page.getByRole('button', {name:'models', exact:true}).click();
    const permissions = page.getByRole('region', {name:'Pilot permissions'});
    await permissions.waitFor();
    assert.match(await permissions.textContent(), /Pilot can always read the vault/);
    await permissions.getByRole('button', {name:'+ Add folder', exact:true}).click();
    assert.equal(await permissions.locator('select').count(), 0, 'Pilot settings offer no write grant');
    assert(!/Read & write|Unrestricted/.test(await permissions.textContent()));
    assert.deepEqual(errors, []);
    console.log('Connected Agent production-shell checks passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
