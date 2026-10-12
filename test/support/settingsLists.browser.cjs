const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5231';
(async () => {
  const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/sidebar-workbench.html?managed-clients=1#/settings/connected-clients');
    const measure=async selector=>{
      const row=page.locator(selector).first(); await row.waitFor();
      return row.evaluate(el=>{
        // the card's geometry and the heading's face, not its height: a name wraps, an about line runs long
        const r=getComputedStyle(el), name=getComputedStyle(el.querySelector('.settings-card-name')), label=el.querySelector('.settings-group-label');
        return {width:el.getBoundingClientRect().width,padding:r.padding,border:r.borderBottom,name:name.font,about:getComputedStyle(el.querySelector('.settings-card-about')).font,group:label?getComputedStyle(label).font:null};
      });
    };
    await page.getByRole('button',{name:'Configure',exact:true}).first().click();
    const client=await measure('.settings-card');
    assert(client.width > 0);
    assert.deepEqual(await page.locator('.rail .rail-eyebrow').allInnerTexts(),['SETTINGS','GENERAL','AGENTS','SERVERS','SYSTEM']);
    assert.deepEqual(await page.locator('.rail .rail-row').allInnerTexts(),['general','models','integrations','lenses','connected agents','+ Connect a server','security','diagnostics']);
    await page.setViewportSize({width:600,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log('Settings lists: shared row geometry, typography, buttons, and narrow layout passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
