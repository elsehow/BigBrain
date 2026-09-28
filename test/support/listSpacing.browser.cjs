const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage();
 for(const width of [1440,380]){
 await page.setViewportSize({width,height:850});
 await page.goto('http://127.0.0.1:5204/sidebar-workbench.html');
 await page.keyboard.press('r');await page.locator('.search-hit').first().waitFor();
 const recent=await page.locator('.selection-actions').boundingBox();
 let first=await page.locator('.search-hit').first().boundingBox();
 assert(first.y>=recent.y+recent.height,'Recents hint must not overlap first row');
 await page.keyboard.press('/');await page.locator('#topbar input').fill('Atlas');
 await page.waitForTimeout(400);await page.locator('.search-hit').first().waitFor();
 const search=await page.locator('.selection-actions').boundingBox();
 first=await page.locator('.search-hit').first().boundingBox();
 assert(first.y>=search.y+search.height,'Search hint must not overlap first row');
 assert.equal(search.x,recent.x,'Search and Recents hint gutters match');
 await page.locator('#topbar input').fill('no-matching-result');await page.getByText('No results.',{exact:true}).waitFor();
 const empty=await page.getByText('No results.',{exact:true}).boundingBox();
 assert.equal(empty.x,search.x,'Empty state uses same gutter');
 }
 console.log('Search/Recents rows and empty states align without overlap at desktop and narrow widths.');
}finally{await browser.close();}})();
