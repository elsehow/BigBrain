const {chromium} = require('playwright-core');
const assert = require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto('http://127.0.0.1:5204/sidebar-workbench.html?notification=question');
 await page.locator('.pilots-trigger .attention-dot').waitFor({state:'visible'});
 for (const selector of ['.pilots-trigger','.recents-trigger','.sidebar-search-trigger','.gear']) {
  assert.equal(await page.locator('#topbar '+selector).evaluate(el=>getComputedStyle(el).borderRadius),'0px');
 }
 assert.notEqual(await page.locator('.pilots-trigger').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 await page.keyboard.press('c'); await page.keyboard.press('j'); await page.waitForTimeout(1000);
 const selected=await page.locator('.workspace-menu .current').innerText();
 await page.evaluate(()=>window.dispatchEvent(new Event('sidebar:camera')));
 const graph=JSON.parse(await page.locator('.sidebar-presentation').textContent());
 const node=graph.nodes.find(n=>n.visible && n.group==='entity' && n.x>360 && n.x<1350 && n.y>120 && n.y<750);
 assert(node,'A visible entity should be available to hover');
 await page.mouse.move(node.x,node.y); await page.locator('.sidebar-quick').waitFor();
 assert.equal(await page.locator('.workspace-menu .current').innerText(),selected);
 await page.keyboard.press('r'); await page.locator('.search-hit').first().waitFor();
 await page.keyboard.press('Escape'); await page.waitForTimeout(220);
 assert.equal(await page.locator('html').getAttribute('data-sidebar-workbench'),'closed');
 await page.keyboard.press('Escape'); await page.waitForTimeout(200);
 assert.equal(await page.locator('#topbar').evaluate(el=>getComputedStyle(el).visibility),'hidden');
 await page.mouse.move(1300,700); await page.waitForTimeout(170);
 assert.equal(await page.locator('#topbar').evaluate(el=>getComputedStyle(el).visibility),'visible');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('#topbar').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
 console.log('Square tabs, inverted notification, hover during memory selection, Escape fade, and reduced motion passed.');
 } finally {await browser.close();}
})();
