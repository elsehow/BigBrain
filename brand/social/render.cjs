// Export the actual animated mark at a fixed point in its turn.
// PLAYWRIGHT_MODULE=/path/to/playwright node brand/social/render.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '../..');
const source = readFileSync(join(root, 'docs/design/mark/bigbrain-cube.html'), 'utf8').split('<!-- ==== DROP-IN:')[1].split('<!-- ==== /DROP-IN')[0];
const style = source.match(/<style>([\s\S]*?)<\/style>/)[1];
const markup = source.match(/<div class="bb-cube"[^>]*>[\s\S]*?<\/div>/)[0];
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const tokens = readFileSync(join(root, 'web/ui/src/design/tokens.css'), 'utf8').replace(/^@import[^;]+;\s*/m, '');
const font = readFileSync(join(root, 'clients/browser-extension/fonts/hanken-grotesk-latin.woff2')).toString('base64');
(async () => {
 const browser = await chromium.launch({headless:true, channel:'chrome'});
 try {
  for (const asset of [
   {name:'avatar-blue', theme:'web', width:1024, height:1024},
   {name:'avatar-light', theme:'default', width:1024, height:1024},
   {name:'x-banner-blue', theme:'web', width:1500, height:500, banner:true},
  ]) {
   const page = await browser.newPage({viewport:{width:asset.width,height:asset.height}, deviceScaleFactor:1});
   await page.setContent(`<!doctype html><html data-theme="${asset.theme}"><head><style>
    ${tokens}\n${style}
    @font-face {font-family:'Hanken Grotesk';font-style:normal;font-weight:400 600;src:url(data:font/woff2;base64,${font}) format('woff2');}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:'Hanken Grotesk',sans-serif;}
    main{width:${asset.width}px;height:${asset.height}px;display:flex;align-items:center;justify-content:center;}
    main .bb-cube{--bb-size:${asset.banner ? 380 : 1150}px;--bb-face-x:var(--fg);--bb-face-y:var(--activity);--bb-face-z:color-mix(in srgb,var(--fg) 70%,var(--bg));--bb-cut:var(--bg);flex:none;}
    .banner{justify-content:flex-start;padding-left:235px;gap:12px;}
    .copy{margin-top:-6px;} h1{font-size:86px;font-weight:500;letter-spacing:-4px;line-height:1.02;margin:0 0 23px;} h1 span{color:var(--activity);}
    p{font-size:25px;margin:0;letter-spacing:-.3px;} .url{font-size:17px;margin-top:24px;opacity:.72;}
   </style></head><body><main class="${asset.banner ? 'banner' : ''}">${markup}${asset.banner ? '<div class="copy"><h1>Now that’s<br><span>BigBrain.</span></h1><p>Agent context for your whole life.</p><p class="url">bigbrain.cool</p></div>' : ''}</main></body></html>`);
   await page.evaluate(() => {performance.now = () => 0; window.requestAnimationFrame = fn => {window.nextCubeFrame = fn;return 1;};});
   await page.addScriptTag({content:script});
   await page.evaluate(async () => {await document.fonts.ready; window.nextCubeFrame(285);});
   await page.screenshot({path:join(__dirname,`${asset.name}.png`)});
   await page.close();
  }
 } finally {await browser.close();}
})();
