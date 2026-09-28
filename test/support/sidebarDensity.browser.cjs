const {chromium}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto((process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5218') + '/sidebar-workbench.html');
 await page.waitForFunction(()=>document.documentElement.dataset.sidebarWorkbench==='closed');
 const measure=async(header,row,title)=>({
   header:await page.locator(header).boundingBox(),
   row:await page.locator(row).first().boundingBox(),
   title:await page.locator(title).first().evaluate(el=>({size:getComputedStyle(el).fontSize,weight:getComputedStyle(el).fontWeight}))
 });
 await page.keyboard.press('r');
 await page.locator('.search-hit').first().waitFor();
 const recents=await measure('.list-title-bar','.search-hit','.hit-title');
 await page.screenshot({path:'/tmp/uniform-recents.png'});
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.documentElement.dataset.sidebarWorkbench==='closed');
 await page.keyboard.press('a');
 await page.locator('.pilot-row').first().waitFor();
 const agents=await measure('.pilots-pane > header','.pilot-row','.row-heading strong');
 await page.screenshot({path:'/tmp/uniform-agents.png'});
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.documentElement.dataset.sidebarWorkbench==='closed');
 await page.keyboard.press('/');
 await page.getByRole('combobox',{name:'Search the vault'}).fill('Atlas');
 await page.waitForFunction(()=>document.querySelector('.search-hit')?.textContent.includes('Atlas'));
 const field=await page.locator('.recents-heading .field').boundingBox();
 const input=await page.getByRole('combobox',{name:'Search the vault'}).boundingBox();
 assert(input.y >= field.y && input.y + input.height <= field.y + field.height,'search input fits its compact control');
 const search=await measure('.list-title-bar','.search-hit','.hit-title');
 await page.screenshot({path:'/tmp/uniform-search.png'});
 const presentation=()=>page.evaluate(()=>{window.dispatchEvent(new Event('sidebar:camera'));return JSON.parse(document.querySelector('.sidebar-presentation').textContent);});
 const first=(await presentation()).view.selected;
 await page.keyboard.press('ArrowDown');
 await page.waitForTimeout(700);
 assert.notDeepEqual((await presentation()).view.selected,first,'search selection updates graph focus');
 assert.equal(await page.getByRole('combobox',{name:'Search the vault'}).evaluate(el=>el===document.activeElement),true,'search keeps input focus');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('html').getAttribute('data-sidebar-workbench'),'open','first Escape keeps search panel open');
 assert.equal(await page.getByRole('combobox',{name:'Search the vault'}).evaluate(el=>el===document.activeElement),false,'first Escape leaves input');
 await page.keyboard.press('j');
 assert(await page.locator('.search-hit.current').count(),'J navigates search results after leaving input');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.documentElement.dataset.sidebarWorkbench==='closed');
 await page.keyboard.press('j');
 await page.locator('.workspace-menu').waitFor();
 await page.keyboard.press('j');
 await page.locator('.workspace-menu .agent-row.current').waitFor();
 await page.keyboard.press('Enter');
 await page.locator('.pilot-panel').waitFor();
 await page.keyboard.press('Escape');
 await page.locator('.workspace-menu').waitFor();
 await page.keyboard.press('/');
 await page.getByRole('combobox',{name:'Search the vault'}).fill('Atlas');
 await page.waitForFunction(()=>document.querySelector('.search-hit')?.textContent.includes('Atlas'));
 const afterChat=(await presentation()).view.selected;
 assert(!afterChat.some(id=>id.startsWith('pilot-')),'search overrides the remembered Pilot preview');

 for(const other of [agents,search]) {
  assert.equal(other.header.y,recents.header.y,'panels start at same height');
  assert.equal(other.header.height,recents.header.height,'header height matches Recents');
  assert.equal(other.row.y,recents.row.y,'first rows align');
  assert.equal(other.row.height,recents.row.height,'row density matches Recents');
  assert.deepEqual(other.title,recents.title,'row typography matches Recents');
 }
 assert.equal(errors.length,0,errors.join('\n'));
 console.log('Search, Agents and Recents header positions, row heights and typography match.');
 } finally {await browser.close();}
})();
