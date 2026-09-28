// Run with a local Vite server. See ../README.md for setup and editable timing.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const name = process.argv[2];
if (!['meeting', 'inbox'].includes(name)) throw Error('Usage: node record.cjs meeting|inbox');
const base = process.env.DEMO_URL || 'http://127.0.0.1:5181';
const output = resolve(process.env.DEMO_OUTPUT || join(__dirname, '..'));
const take = new Date().toISOString().replace(/[:.]/g, '-');
const assets = join(output, 'takes', `${name}-${take}`);
mkdirSync(assets, { recursive: true });
const filename = `${name === 'meeting' ? 'BigBrain-meeting-agent' : 'BigBrain-inbox-36-unreads-blue'}-${take}-1080p.mp4`;

(async () => {
  const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: assets, size: { width: 1920, height: 1080 } } });
  const page = await context.newPage();
  const errors = [], beats = [], started = Date.now();
  const beat = label => beats.push({ label, seconds: +( (Date.now() - started) / 1000 ).toFixed(3) });
  const hold = ms => page.waitForTimeout(ms);
  const snap = label => page.screenshot({ path: join(assets, `${label}.png`) });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.duplicateFrames = [];
    const sample = () => {
      const text = [...document.querySelectorAll('.message.user .user-text')].map(el => el.textContent.trim());
      if (new Set(text).size !== text.length) window.duplicateFrames.push(text);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  let video, duplicates;
  try {
    await page.goto(`${base}/${name === 'meeting' ? 'meeting-action' : 'inbox'}-demo.html`);
    await page.locator('input').waitFor({ state: 'attached' });
    beat('populated graph'); await hold(2600); await snap('opening');
    if (name === 'meeting') {
      await page.keyboard.press('Meta+k');
      await page.keyboard.type('Weekly sync', { delay: 35 });
      const hit = page.getByText('Weekly sync with Alex', { exact: true }).first();
      await hit.waitFor(); await hold(650); await hit.click();
      await page.locator('.note-title').waitFor(); beat('meeting open'); await hold(900);
      await page.locator('.note-title').click(); await page.locator('input').evaluate(el => el.blur());
    }
    await page.keyboard.press('Shift+Enter');
    await page.locator('.editor').waitFor();
    if (name === 'inbox') {
      await page.getByRole('button', { name: 'Standard text tab', exact: true }).click();
      await page.locator('.pilot-panel .context').filter({ hasText: '36' }).waitFor();
      beat('Pilot attached to all 36 unread messages'); await hold(1500); await snap('all-connected');
    }
    await page.locator('.editor').click();
    const prompt = name === 'meeting' ? 'What are the action items?' : 'What needs my attention?';
    await page.keyboard.type(prompt, { delay: name === 'meeting' ? 35 : 65 });
    await hold(300); beat('question sent'); await page.keyboard.press('Enter');
    await page.getByText(name === 'meeting' ? 'Three things before Friday' : '36 unread. Three need you.', { exact: true }).waitFor();
    if (name === 'inbox') await page.getByRole('button', { name: 'Expand text tab', exact: true }).click();
    await hold(400); await page.locator('.transcript').evaluate(el => el.scrollTop = 0);
    beat('answer and focused context'); await page.mouse.move(1700,950); await snap('answer');
    if (name === 'meeting') {
      await hold(1200); await page.locator('.editor').click();
      await page.keyboard.type('Do them.', { delay: 90 }); beat('Do them sent'); await page.keyboard.press('Enter');
      await page.getByText('Started an agent to compare the approaches, draft your recommendation, and prepare the interview questions.', { exact: true }).waitFor();
      await hold(500); await page.getByRole('button', { name: 'Standard text tab', exact: true }).click();
      await page.mouse.move(1700,750); beat('agent working, compact text tab');
      await hold(2000); await snap('agent-working'); await hold(3500);
    } else await hold(4500);
    duplicates = await page.evaluate(() => window.duplicateFrames);
    video = await page.video().path();
    if (errors.length || duplicates.length) throw Error(JSON.stringify({ errors, duplicates }));
  } finally {
    await context.close(); await browser.close();
    writeFileSync(join(assets, 'timings.json'), JSON.stringify({ name, base, viewport: '1920x1080', beats, errors, duplicateFrames: duplicates?.length }, null, 2));
  }
  execFileSync('ffmpeg', ['-y','-loglevel','error','-i',video,'-vf','fps=30','-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',join(output, filename)], { stdio: 'inherit' });
  console.log(JSON.stringify({ video: join(output,filename), take: assets, beats }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
