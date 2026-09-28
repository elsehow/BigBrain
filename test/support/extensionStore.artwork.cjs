// Layout real Chromium captures on 1280×800 store artboards. No invented UI.
// Usage: EXTENSION_SCREENSHOTS=/path/to/raw STORE_ARTWORK=/path/to/output node test/support/extensionStore.artwork.cjs
const { chromium } = require('playwright-core');
const { readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const source = process.env.EXTENSION_SCREENSHOTS;
const out = process.env.STORE_ARTWORK;
if (!source || !out) throw Error('Set EXTENSION_SCREENSHOTS and STORE_ARTWORK');
const png = name => `data:image/png;base64,${readFileSync(join(source,name)).toString('base64')}`;
(async () => {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const scenes = [
      ['01-save-a-page.png', 'Save the page.<br>Keep the context.', 'Send web pages to your BigBrain vault.', 'chromium-popup.png'],
      ['02-add-a-note.png', 'Remember why<br>it matters.', 'Add a note alongside what you save.', 'chromium-note.png'],
      ['03-connect.png', 'Your browser.<br>Your BigBrain.', 'Pair with the BigBrain desktop app.', 'chromium-options.png'],
    ];
    for (const [file,title,description,shot] of scenes) {
      const connected = shot.includes('options');
      await page.setContent(`<!doctype html><style>
        *{box-sizing:border-box}body{margin:0;background:#f3f1ec;color:#292624;font-family:Arial,sans-serif}
        .copy{position:absolute;left:64px;top:175px;width:480px}.brand{font-size:16px;letter-spacing:3px;font-weight:700}
        h1{font-size:55px;line-height:1.08;letter-spacing:-2px;margin:35px 0 24px}p{font-size:22px;line-height:1.5;max-width:390px;color:#68615b}
        .card{position:absolute;right:64px;top:205px;width:558px;overflow:hidden;border-radius:24px;box-shadow:0 24px 60px #30282025;background:white}
        .popup{display:block;width:558px}.connected{height:351px}.connected img{position:absolute;width:1920px;max-width:none;left:-681px;top:-84px}
        footer{position:absolute;left:64px;bottom:55px;font-size:16px;color:#68615b} .dot{display:inline-block;width:12px;height:12px;background:#da483c;margin-right:10px}
        </style><div class="copy"><div class="brand"><span class="dot"></span>SEND TO BIGBRAIN</div><h1>${title}</h1><p>${description}</p></div>
        <div class="card ${connected?'connected':''}"><img class="popup" src="${png(shot)}"></div>
        <footer>Requires the BigBrain desktop app · bigbrain.cool</footer>`);
      await page.locator('img').evaluate(img=>img.decode());
      await page.screenshot({ path: join(out,file) });
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
