// production base and Field and real initialization; every API and external request is intercepted.
const { chromium, webkit } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const base = process.env.VIEWER_URL || 'http://127.0.0.1:5305';
(async () => {
 const browser = process.env.BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
 try {
  const page = await browser.newPage({ reducedMotion: 'no-preference', viewport: { width: 1000, height: 900 } });
  const errors = [], outbound = [], choices = [];
  const feedbackRequests = []; let feedbackFails = true;
  page.on('pageerror', e => errors.push(e.message));
  let presenceCalls = 0;
  let phase, metrics, failConsent = false, failComplete = false;
  const reset = (step = 'integrations', extra = {}) => {
   phase = step;
   metrics = { enabled: false, decided: false, configured: true, samples: [], operations: {}, actions: {}, queued: 0, delivery: 'idle', ...extra };
  };
  reset();
  await page.route('**/*', async route => {
   const request = route.request(), url = new URL(request.url());
   if (url.origin !== new URL(base).origin) { outbound.push(url.host); return route.abort(); }
   if (url.pathname === '/dist/index.html') return route.fulfill({ contentType: 'text/html', body: readFileSync('web/ui/dist/index.html', 'utf8'), headers: { 'content-security-policy': execFileSync('bun', ['-e', 'import { CSP } from "./lib/httpx.ts"; process.stdout.write(CSP)'], { encoding: 'utf8' }) } });
   if (!url.pathname.startsWith('/api/')) return route.continue();
   const path = url.pathname, data = request.postDataJSON(), json = value => route.fulfill({ json: value });
   if (path === '/api/feedback') {
    feedbackRequests.push(data);
    return feedbackFails ? route.fulfill({ status: 502, json: { error: 'Synthetic feedback failure' } }) : json({ ok: true });
   }
   const setup = () => ({ onboarding: phase, vault: { path: '/synthetic/vault', created: null }, identity: { name: 'Synthetic', entity_id: 'fixture' }, claude: { installed: false, account: null, connected: true }, agent: null });
   if (path === '/api/setup') return json(setup());
   if (path === '/api/setup/progress') {
    if (failComplete && data.step === 'complete') return route.fulfill({ status: 500, json: { error: 'Simulated finish failure' } });
    phase = data.step; return json(setup());
   }
   if (path === '/api/telemetry') {
    if (typeof data?.foreground === 'boolean') presenceCalls++;
    if (typeof data?.enabled === 'boolean') {
     choices.push(data.enabled);
     if (failConsent) return route.fulfill({ status: 500, json: { error: 'Simulated consent failure' } });
     metrics = { ...metrics, enabled: data.enabled, decided: true, queued: 0 };
    }
    return json(metrics);
   }
   if (path === '/api/integration-accounts') return json({ accounts: [], library: [] });
   if (path === '/api/graph') return json({ nodes: [], edges: [], hash: 'fixture' });
   if (path === '/api/diagnostics') return json({ facts: { at: '2026-09-25T00:00:00Z', engine: 'fixture', bundle: null, supervisor: null, supervisorAlive: false, vault: '/synthetic/vault', platform: 'darwin', bun: 'fixture', jobsPath: '/synthetic/bin', claude: { path: null, loggedIn: false }, nextFires: null, intake: { running: false, lockPid: null } }, logs: [] });
   if (path === '/api/recent') return json({ recent: [], total: 0, nextOffset: null });
   if (path === '/api/pilot/chat' || path === '/api/work/sessions') return json({ sessions: [] });
   if (path === '/api/source/read-state') return json({ sources: [], scope: 'stored_sources' });
   return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
  });
  const url = base + '/dist/index.html';
  // Drain mocked presence requests before tearing down a WebKit document.
  const navigate = async target => { await page.waitForLoadState('networkidle'); await page.goto(target); };
  const reload = async () => { await page.waitForLoadState('networkidle'); await page.reload(); };
  const prompt = page.getByRole('heading', { name: 'Help improve BigBrain', exact: true });
  const absent = async () => { await page.locator('.v2').waitFor(); assert.equal(await prompt.count(), 0); };
  await navigate(url);
  await page.getByRole('heading', { name: 'Connect integrations', exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  const beforeHide = presenceCalls;
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide')); window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(100); assert.equal(presenceCalls, beforeHide);
  const resumed = page.waitForResponse(r => r.url().endsWith('/api/telemetry') && r.request().method() === 'POST');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow'))); await resumed;
  assert.equal(presenceCalls, beforeHide + 1);
  assert.equal(await prompt.count(), 0); assert.deepEqual(choices, []);
  await page.getByRole('button', { name: 'Next →', exact: true }).click(); await prompt.waitFor();
  assert.equal(phase, 'analytics'); assert.equal(metrics.enabled, false); assert.deepEqual(choices, []);
  await reload(); await prompt.waitFor(); // Pending phase survives restart.
  const yes = page.getByRole('button', { name: 'Opt-in!', exact: true });
  const no = page.getByRole('button', { name: 'No thanks', exact: true });
  assert.deepEqual(await page.locator('.consent-actions button').allTextContents(), ['No thanks', 'Opt-in!']);
  assert.equal(await yes.evaluate(el => el === document.activeElement), false);
  const contrast = el => {
   const s = getComputedStyle(el), context = document.createElement('canvas').getContext('2d');
   const light = color => {
    context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    const c = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
   };
   const bg = s.backgroundColor === 'rgba(0, 0, 0, 0)' ? s.getPropertyValue('--bg') : s.backgroundColor;
   const a = light(s.color), b = light(bg);
   return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const theme of ['default', 'dusk', 'kind-of-blue-light', 'kind-of-blue-dark', 'web', 'somethings-gotta-give', 'moegiiro', 'adzukiiro', 'asagiiro']) {
   await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
   await page.mouse.move(0, 0);
   assert(await no.evaluate(contrast) >= 4.5, `${theme}: decline contrast`);
   assert(await yes.evaluate(contrast) >= 4.5, `${theme}: opt-in contrast`);
   assert.equal(await yes.evaluate(el => getComputedStyle(el).borderRadius), '0px');
   const box = await yes.boundingBox();
   assert((await no.boundingBox()).x < box.x);
   await yes.hover();
   assert(await yes.evaluate(contrast) >= 4.5, `${theme}: hover contrast`);
   assert.notEqual(await yes.evaluate(el => getComputedStyle(el).boxShadow), 'none');
   assert.deepEqual(await yes.boundingBox(), box);
   await page.mouse.down();
   assert.match(await yes.evaluate(el => getComputedStyle(el).boxShadow), /inset/);
   assert(await yes.evaluate(contrast) >= 4.5, `${theme}: pressed contrast`);
   await page.mouse.move(0, 0); await page.mouse.up(); // Release outside: no consent.
   assert.deepEqual(choices, []);
   assert.deepEqual(await yes.boundingBox(), box);
  }
  assert.equal(await yes.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  // macOS WebKit uses Option-Tab to include controls with system keyboard navigation off.
  await no.focus(); await page.keyboard.press(process.env.BROWSER === 'webkit' ? 'Alt+Tab' : 'Tab');
  assert(await yes.evaluate(el => el === document.activeElement && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none'));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'default'));
  assert.equal(await page.locator('input[type=checkbox],input[type=radio]').count(), 0);
  const summary = page.locator('summary').filter({ hasText: "What's collected" });
  await summary.focus(); await page.keyboard.press('Enter');
  assert(await page.getByText(/Engine version, operating system and architecture/).isVisible());
  assert.equal(await page.getByRole('link', { name: 'Privacy policy' }).getAttribute('href'), 'https://bigbrain.cool/privacy');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `/tmp/bb-analytics-${process.env.BROWSER || 'chrome'}.png`, fullPage: true });
  failConsent = true; await yes.click(); await page.getByRole('alert').waitFor();
  assert.equal(metrics.enabled, false); assert.equal(phase, 'analytics');
  failConsent = false; await no.click(); await absent();
  assert.equal(phase, 'complete'); assert.equal(metrics.decided, true); assert.equal(metrics.enabled, false);
  await reload(); await absent();
  // Actual combined shell: feedback remains independent after declining analytics.
  await page.setViewportSize({ width: 1000, height: 900 });
  const feedback = page.getByRole('button', { name: 'Feedback', exact: true });
  await feedback.focus(); await feedback.click();
  const message = page.getByRole('textbox', { name: 'What could we improve?' });
  await message.fill('Synthetic combined onboarding feedback');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic feedback failure' }).waitFor();
  await page.getByRole('button', { name: 'Close feedback', exact: true }).click();
  await feedback.click(); assert.equal(await message.inputValue(), 'Synthetic combined onboarding feedback');
  feedbackFails = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Thanks — your feedback was sent.' }).waitFor();
  assert.equal(metrics.enabled, false); assert.deepEqual(choices, [true, false]);
  assert.equal(feedbackRequests.length, 2); assert.deepEqual(feedbackRequests[0], feedbackRequests[1]);
  assert.deepEqual(Object.keys(feedbackRequests[0]).sort(), ['id', 'layout', 'message', 'panel', 'version']);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  reset('analytics'); await reload(); await prompt.waitFor();
  // Consent is durable even if saving onboarding completion subsequently fails.
  failComplete = true; await yes.click(); await page.getByRole('alert').waitFor(); assert.equal(metrics.enabled, true);
  assert.equal(await yes.count(), 0); assert.equal(phase, 'analytics');
  await reload(); await page.getByRole('button', { name: 'Finish →', exact: true }).waitFor();
  assert.equal(await yes.count(), 0); failComplete = false;
  await page.getByRole('button', { name: 'Finish →', exact: true }).click(); await absent();
  await navigate(url + '#/diagnostics');
  const toggle = page.getByRole('checkbox', { name: 'Share usage and performance statistics' });
  await toggle.waitFor(); assert(await toggle.isChecked()); await toggle.uncheck();
  await page.getByText('Sharing is off.', { exact: true }).waitFor(); await reload(); await absent(); assert(!(await toggle.isChecked()));
  for (const enabled of [false, true]) {
   reset('integrations', { enabled, decided: true }); await navigate(url);
   await page.getByRole('button', { name: 'Finish →', exact: true }).click(); await absent(); assert.equal(metrics.enabled, enabled);
  }
  for (const phase of [undefined, 'complete']) {
   reset(phase ?? null); // A legacy vault has no progress marker.
   await navigate(url); await absent(); assert.equal(metrics.enabled, false);
  }
  reset('integrations', { configured: false }); await navigate(url);
  await page.getByRole('button', { name: 'Finish →', exact: true }).click(); await absent();
  assert.deepEqual(choices, [true, false, true, false]); assert.deepEqual(errors, []);
  assert(outbound.every(host => host === 'fonts.googleapis.com')); // If attempted, external fonts are blocked too.
  console.log('PASS: combined built production base and Field; consent ordering/contrast, failures/reloads, existing choices, withdrawal, independent feedback while opted out, draft/retry identity and metadata allowlist; all API mocked, no analytics or feedback delivery.');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
