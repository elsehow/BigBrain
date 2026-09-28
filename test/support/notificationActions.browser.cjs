const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5204'}/sidebar-workbench.html?notification=question`);
 await page.getByRole('region',{name:'Agent notification'}).waitFor();
 await page.keyboard.press('o'); await page.locator('.notice-message').waitFor();
 const notice=page.locator('.notice-message');
 await notice.getByRole('button',{name:/Mark unread/}).waitFor();
 assert.equal(await notice.getByRole('button',{name:/Select|Reply/}).count(),0);
 const editor=page.locator('.pilot-panel [contenteditable="true"]');
 await editor.focus();
 assert(await notice.getByRole('button',{name:/Mark unread/}).isVisible());
 assert(!(await notice.locator('.keyboard-hint').isVisible()));
 await page.keyboard.press('Escape');
 assert(await notice.locator('.keyboard-hint').isVisible());
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('contenteditable'))=== 'true',false);
 assert.equal(await page.locator('.pilot-panel').count(),1);
 await page.keyboard.press('Shift+u'); await page.locator('.notice-unread').waitFor();
 await page.waitForTimeout(1700); assert.equal(await page.locator('.notice-unread').count(),1);
 await editor.focus();
 await page.keyboard.type('Use the September date.'); await page.keyboard.press('Enter');
 await page.waitForTimeout(250);
 const session=await page.evaluate(async()=> (await (await fetch('/api/pilot/chat')).json()).sessions.find(s=>s.title==='Atlas planning'));
 assert.equal(session.notifications[0].resolved,true);
 assert.equal(await notice.locator('.notification-actions').count(),0);
 await page.keyboard.press('Escape');
 await page.screenshot({path:'/tmp/bb-notification-chat.png'});
 await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
 await page.keyboard.press('r'); const h=(await page.locator('.recents-title-bar').boundingBox()).height;
 const hint=await page.locator('.selection-actions').boundingBox(), first=await page.locator('.search-hit').first().boundingBox();
 assert(first.y>=hint.y+hint.height);
 await page.locator('.search-hit').first().click(); await page.locator('.note-history').waitFor();
 assert.equal((await page.locator('.hud-header').boundingBox()).height,h);
 console.log('Thread read, Escape blurs, Shift-U marks unread, next turn clears actions, header layout and conditional history passed.');
 }finally{await browser.close();}
})();
