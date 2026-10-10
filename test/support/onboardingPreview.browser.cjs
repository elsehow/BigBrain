// Exercise the browser-only fixture through production base and Field initialization.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
  const errors = [], apiRequests = [], blocked = [];
  const base = process.env.VIEWER_URL || 'http://127.0.0.1:5305';
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
   const url = new URL(route.request().url());
   if (url.pathname.startsWith('/api/')) { apiRequests.push(url.pathname); return route.abort(); }
   if (url.origin !== new URL(base).origin) { blocked.push(url.host); return route.abort(); }
   return route.continue();
  });
  await page.goto(`${base}/sidebar-workbench.html?onboarding=start&feedback=failure`);
  await page.getByRole('button', { name: 'CREATE', exact: true }).click();
  await page.getByRole('button', { name: 'GO', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Sample');
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByRole('region', { name: 'Claude provider' }).getByRole('button', { name: 'Connect Claude', exact: true }).click();
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByRole('heading', { name: 'Connect agents', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('heading', { name: 'Connect integrations', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('heading', { name: 'Help improve BigBrain', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.step-content[inert]'));
  await page.screenshot({ path: '/tmp/bb-onboarding-preview.png' });
  await page.getByRole('button', { name: 'Opt-in!', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Set up BigBrain"]'));
  await page.reload();
  await page.locator('.v2').waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bb-preview-onboarding-v1')));
  assert.equal(saved.metrics.enabled, true); assert.equal(saved.setup.onboarding, 'complete');
  const feedback = page.getByRole('button', { name: 'Feedback', exact: true });
  await feedback.focus(); await feedback.click();
  const message = page.getByRole('textbox', { name: 'What could we improve?' });
  await message.fill('Synthetic preview response');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Simulated connection failure' }).waitFor();
  await page.getByRole('button', { name: 'Close feedback', exact: true }).click();
  // A mouse-focused trigger remains usable when the chrome idle timer expires.
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('.feedback-trigger')?.classList.contains('visible'));
  assert.equal(await feedback.evaluate(el => getComputedStyle(el).pointerEvents), 'auto', 'focused Feedback remains clickable while idle');
  await page.getByRole('combobox', { name: 'Simulated feedback outcome' }).selectOption('success');
  await feedback.click(); assert.equal(await message.inputValue(), 'Synthetic preview response');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Thanks — your feedback was sent.' }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Restart preview', exact: true }).click();
  await page.getByRole('heading', { name: 'Where should your vault live?', exact: true }).waitFor();
  assert.deepEqual(apiRequests, []); assert.deepEqual(errors, []);
  assert(blocked.every(host => host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com'));
  console.log('PASS: combined interactive Field preview, synthetic initialization/consent, feedback failure/draft/retry, reload/restart; no API network traffic.');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
