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
    const add=await page.locator('.settings-add').evaluate(el=>({height:el.getBoundingClientRect().height,padding:getComputedStyle(el).padding}));
    for(const tab of ['connected agents']){
      await page.locator('.rail').getByRole('button',{name:tab,exact:true}).click();
      await page.getByText('Project environments',{exact:true}).waitFor();
      const project=await measure('.projects .settings-card'); assert.equal(project.name,client.name); assert.equal(project.about,client.about);
      assert.deepEqual(await page.locator('.settings-add').evaluate(el=>({height:el.getBoundingClientRect().height,padding:getComputedStyle(el).padding})),add,tab+' uses the same add button');
      await page.screenshot({path:'/tmp/bb-uniform-'+tab.replaceAll(' ','-')+'.png'});
    }
    await page.setViewportSize({width:600,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log('Settings lists: shared row geometry, typography, buttons, and narrow layout passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
