const {chromium}=require('playwright-core');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.addInitScript(()=>localStorage.setItem('bigbrain:theme','web'));
 await page.goto('http://127.0.0.1:5204/sidebar-workbench.html');
 await page.keyboard.press('r');await page.locator('.search-hit').first().click();await page.waitForTimeout(400);
 await page.keyboard.press('Escape');await page.waitForTimeout(400);
 await page.mouse.move(1350,850);await page.waitForTimeout(400);
 const shot=await page.screenshot();
 const black=await page.evaluate(async data=>{
  const img=await createImageBitmap(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'image/png'}));
  const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
  const g=c.getContext('2d');g.drawImage(img,0,0);const d=g.getImageData(0,0,c.width,c.height).data;
  let dark=0;for(let i=0;i<d.length;i+=4)if(d[i]<25&&d[i+1]<25&&d[i+2]<150)dark++;
  return dark;
 },shot.toString('base64'));
 require('node:assert/strict').equal(black,0,'No black trail pixels on the blue theme after leaving a note');
 console.log('Blue theme has no black trail artifacts after selection/unfocus.');
 await page.screenshot({path:'/tmp/bb-blue-depth.png'});

}finally{await browser.close();}})();
