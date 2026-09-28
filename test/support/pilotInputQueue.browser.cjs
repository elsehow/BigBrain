// Production AppShell (sidebar-workbench ?pilotNetwork) against a stateful
// page.route engine that applies the real Pilot transitions and projections
// (lib/pilotTransitions.ts, lib/pilotChatSummary.ts). Invented conversations;
// no vault, no model. Covers uncertain delivery (lost and late POST
// responses), the paused FIFO queue, the bounded image upload and the
// 30-second reconcile under a silent event stream.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
const root = resolve(__dirname, '../..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBfcAAAAASUVORK5CYII=';
const EPOCH = 'pilot-network'; // PILOT_NETWORK_EPOCH in src/dev/pilotNetworkFixture.ts

// The engine's own rules, bundled for node: the fake cannot drift from them.
const bundle = mkdtempSync(join(tmpdir(), 'bb-pilot-queue-'));
execFileSync('bun', ['build', 'lib/pilotTransitions.ts', 'lib/pilotChatSummary.ts', 'lib/pilotChatTypes.ts',
  '--target=node', '--format=cjs', '--outdir', bundle], { cwd: root, stdio: 'pipe' });
const { transitionPilot } = require(join(bundle, 'pilotTransitions.js'));
const { pilotChatDetail, pilotChatSummary } = require(join(bundle, 'pilotChatSummary.js'));
const { newPilotChatSession } = require(join(bundle, 'pilotChatTypes.js'));

const pilotId = n => 'pilot-' + String(n).repeat(32);
const now = () => new Date().toISOString();
function conversation(id, title) {
  const s = newPilotChatSession([], id, now()), question = randomUUID();
  Object.assign(s, { title, phase: 'answered', revision: 3, messages: [
    { id: question, role: 'user', text: 'Which survey dates moved?', at: s.created },
    { id: randomUUID(), role: 'assistant', text: 'Two sampling dates moved to the following week.', at: s.created },
  ], inputs: [{ id: randomUUID(), message: question, mode: 'text', text: 'Which survey dates moved?' }] });
  return s;
}

/** PilotChats and pilotChatRoutes, reduced to what these conversations use. */
function fakeEngine(sessions) {
  const state = new Map(sessions.map(s => [s.id, s]));
  const images = new Set(), log = [], unexpected = [], intercept = {};
  const persist = s => { s.revision++; s.updated = now(); };
  const get = id => { const s = state.get(id); if (!s) throw Object.assign(new Error('Pilot conversation is unavailable.'), { status: 404 }); return s; };
  function change(s, event) {
    const { state: next, effects } = transitionPilot(s, event);
    if (next !== s) { persist(next); state.set(next.id, next); }
    for (const effect of effects) if (effect.kind === 'advance' && next.pendingInputs?.length) resume(next.id);
    return state.get(next.id);
  }
  const resume = id => change(get(id), { kind: 'resume', message: randomUUID(), turn: randomUUID(), at: now() });
  function post(path, b) {
    if (path === 'image') {
      const bytes = Buffer.from(String(b.data).replace(/^data:image\/png;base64,/, ''), 'base64');
      const id = createHash('sha256').update(bytes).digest('hex') + '.png'; images.add(id);
      return { id, name: b.name };
    }
    if (path === 'presence') return { ok: true };
    const s = get(b.id);
    if (path === 'draft') {
      if (s.draft === b.text && JSON.stringify(s.draftImages ?? []) === JSON.stringify(b.images ?? s.draftImages ?? [])) return s;
      s.draft = b.text; s.draftImages = b.images ?? s.draftImages ?? []; persist(s); return s;
    }
    if (path === 'send') {
      if (!/^[a-zA-Z0-9_-]{8,150}$/.test(b.inputId)) throw Object.assign(new Error('A stable input ID and input method are required.'), { status: 400 });
      if (b.images?.some(image => !images.has(image.id))) throw Object.assign(new Error('Image unavailable.'), { status: 400 });
      return change(s, { kind: 'input', input: { id: b.inputId, text: b.text.trim(), mode: b.mode, ...(b.images?.length ? { images: b.images } : {}) },
        message: randomUUID(), turn: randomUUID(), at: now(), queue: true });
    }
    if (path === 'resume') return resume(s.id);
    throw Object.assign(new Error(`Unexpected POST ${path}`), { status: 404 });
  }
  async function handle(route) {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const body = method === 'POST' ? request.postDataJSON() : undefined;
    const entry = { method, path, body }; log.push(entry);
    let status = 200, json;
    try {
      if (method === 'GET' && path === '/api/pilot/chat') {
        const ids = url.searchParams.get('ids')?.split(',');
        json = { sessions: [...state.values()].filter(s => !ids || ids.includes(s.id)).map(pilotChatSummary), issues: [] };
      } else if (method === 'GET' && path === '/api/pilot/chat/session') json = pilotChatDetail(get(url.searchParams.get('id')));
      else if (method === 'GET' && path === '/api/pilot/chat/notifications') json = { notifications: [] };
      else if (method === 'GET' && path === '/api/pilot/chat/image') return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
      else if (method === 'POST' && path.startsWith('/api/pilot/chat/')) {
        const result = post(path.slice('/api/pilot/chat/'.length), body);
        json = result && 'messages' in result && 'phase' in result ? pilotChatDetail(result) : result;
      } else { unexpected.push(`${method} ${path}`); status = 404; json = { error: 'Not in this fake.' }; }
    } catch (e) { status = e.status ?? 409; json = { error: e.message }; }
    entry.response = json;
    const deliver = () => route.fulfill({ status, json });
    const hook = intercept[path.split('/').at(-1)];
    return hook ? hook({ route, body, json, deliver }) : deliver();
  }
  return { state, log, unexpected, intercept, handle, get, change, resume, posts: path => log.filter(e => e.method === 'POST' && e.path === `/api/pilot/chat/${path}`),
    /** The model finishes the running turn; the real advance effect starts the next queued input. */
    answer(id, text) {
      const s = get(id), turn = s.turn.id;
      change(s, { kind: 'message', turn, message: { id: randomUUID(), role: 'assistant', text, at: now() } });
      return change(get(id), { kind: 'settled', turn, outcome: 'answered', at: now(), advance: true });
    } };
}

/** Everything the UI showed, in order, recorded on every DOM mutation. */
function monitor() {
  const trace = window.pilotTrace = { events: [], userMax: {} };
  let last = {};
  const note = (kind, value) => { if (last[kind] !== value) { last[kind] = value; trace.events.push({ kind, value }); } };
  const observe = () => {
    const panel = document.querySelector('.pilot-panel');
    note('phase', panel?.dataset.phase ?? null);
    note('status', panel ? [...panel.querySelectorAll('[role=status]')].map(e => e.textContent.trim()).filter(Boolean).join(' | ') : null);
    for (const row of document.querySelectorAll('.pilot-row')) note(`row:${row.dataset.pilot}`, row.getAttribute('aria-label').split(', ').at(-1));
    const texts = [...document.querySelectorAll('.pilot-panel .message.user .user-text')].map(e => e.textContent);
    for (const text of new Set(texts)) trace.userMax[text] = Math.max(trace.userMax[text] ?? 0, texts.filter(t => t === text).length);
  };
  new MutationObserver(observe).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const errors = [];
  let revision = 0;
  async function open(sessions, { clock = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const engine = fakeEngine(sessions);
    await context.route('**/api/**', engine.handle);
    await context.addInitScript(monitor);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.stack));
    if (clock) await page.clock.install();
    await page.goto(`${base}/sidebar-workbench.html?pilotNetwork=1`);
    const pilot = page.getByRole('region', { name: 'Pilot conversation' });
    const ui = {
      page, engine, pilot, context,
      composer: pilot.getByRole('textbox', { name: 'Message Pilot', exact: true }),
      sendButton: pilot.locator('.composer-actions').getByRole('button'),
      users: () => pilot.locator('.message.user .user-text').allTextContents(),
      queued: () => pilot.locator('.queued-input p').allTextContents(),
      trace: () => page.evaluate(() => window.pilotTrace),
      mark: label => page.evaluate(label => window.pilotTrace.events.push({ kind: 'mark', value: label }), label),
      /** One engine invalidation over the event stream, as ApplicationChanges.flush sends it. */
      notify: id => page.evaluate(detail => window.dispatchEvent(new CustomEvent('workbench-application', { detail })),
        { epoch: EPOCH, revision: ++revision, entities: [{ kind: 'pilot', id, revision: engine.get(id).revision }] }),
      /** The detail the UI holds has caught up with the engine's current revision. */
      caughtUp: id => page.waitForFunction(async ({ id, revision }) => {
        const { chat } = await import('/src/lib/pilotChat.svelte.ts');
        return chat.sessions.find(s => s.id === id)?.detailRevision === revision;
      }, { id, revision: engine.get(id).revision }),
      async type(text) { await ui.composer.click(); await page.keyboard.type(text); },
      async paste() {
        await ui.composer.evaluate((el, png) => {
          const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0)), data = new DataTransfer();
          data.items.add(new File([bytes], 'field-sketch.png', { type: 'image/png' }));
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, png);
      },
    };
    revision = 0;
    await page.getByRole('button', { name: 'Agents', exact: true }).focus();
    await page.keyboard.press('a');
    await page.locator(`.pilot-row[data-pilot="${sessions[0].id}"]`).click();
    await pilot.waitFor();
    await ui.caughtUp(sessions[0].id);
    return ui;
  }
  const phasesAfter = (trace, label) => trace.events.slice(trace.events.findIndex(e => e.kind === 'mark' && e.value === label) + 1);
  const shown = (events, kind) => events.filter(e => e.kind === kind).map(e => e.value);

  try {
    // 1. The send POST is recorded, but every response is lost on the wire.
    {
      const id = pilotId(1), text = 'Compare the two survey notebooks.';
      const ui = await open([conversation(id, 'Survey notebooks')], { clock: true });
      const { page, engine } = ui;
      await page.clock.pauseAt(Date.now() + 60_000);
      engine.intercept.send = ({ route }) => route.abort('connectionreset');
      const failed = page.waitForEvent('requestfailed', r => r.url().endsWith('/api/pilot/chat/send'));
      await ui.mark('sent');
      await ui.type(text); await ui.sendButton.click();
      await failed;
      assert.equal(engine.posts('send').length, 1);
      assert.equal(engine.get(id).inputs.at(-1).id, engine.posts('send')[0].body.inputId, 'the engine accepted the input');
      // The client is backing off before its retry. The stream proves delivery.
      await ui.notify(id); await ui.caughtUp(id);
      await ui.pilot.locator('.message.user .user-text', { hasText: text }).waitFor();
      const focus = await page.evaluate(async () => (await import('/src/lib/pilotChat.svelte.ts')).chat.focus);
      await page.clock.runFor(2_000); // past every retry delay
      await page.waitForFunction(async focus => (await import('/src/lib/pilotChat.svelte.ts')).chat.focus > focus, focus);
      assert.equal(engine.posts('send').length, 1, 'a delivery proven by the stream is not sent again');
      assert.deepEqual((await ui.users()).filter(t => t === text), [text]);
      assert.equal(await ui.composer.innerText(), '', 'the delivered message does not return to the composer');
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await ui.pilot.getAttribute('data-phase'), 'working');
      await ui.mark('answered');
      engine.answer(id, 'Notebook B records the later dates.');
      await ui.notify(id);
      await ui.pilot.getByText('Notebook B records the later dates.').waitFor();
      const trace = await ui.trace();
      assert.equal(trace.userMax[text], 1, 'never rendered twice');
      const beforeAnswer = phasesAfter(trace, 'sent').slice(0, phasesAfter(trace, 'sent').findIndex(e => e.kind === 'mark' && e.value === 'answered'));
      assert.ok(!shown(beforeAnswer, 'phase').some(p => p === 'draft' || p === 'answered'), `no Draft or answered while accepted: ${JSON.stringify(beforeAnswer)}`);
      assert.ok(!shown(beforeAnswer, `row:${id}`).some(s => s === 'Draft' || s === 'Ready'));
      assert.equal(await ui.pilot.getAttribute('data-phase'), 'answered');
      assert.deepEqual(engine.unexpected, []);
      await ui.context.close();
    }

    // 2. The send response arrives only after a refresh showed the input
    // delivered and the turn answered.
    {
      const id = pilotId(2), text = 'Which plots were resurveyed?';
      const ui = await open([conversation(id, 'Plot resurvey')]);
      const { page, engine } = ui;
      const held = new Promise(resolve => { engine.intercept.send = resolve; });
      await ui.mark('sent');
      await ui.type(text); await ui.sendButton.click();
      await page.waitForFunction(() => document.querySelector('.pilot-panel')?.dataset.phase === 'working');
      const late = await held;
      assert.equal(late.json.phase, 'working', 'the held response is the engine state at acceptance');
      engine.answer(id, 'Plots 4 and 7 were resurveyed in March.');
      await ui.notify(id); await ui.caughtUp(id);
      await ui.pilot.getByText('Plots 4 and 7 were resurveyed in March.').waitFor();
      assert.equal(await ui.pilot.getAttribute('data-phase'), 'answered');
      await ui.mark('refreshed');
      const focus = await page.evaluate(async () => (await import('/src/lib/pilotChat.svelte.ts')).chat.focus);
      const response = page.waitForResponse(r => r.url().endsWith('/api/pilot/chat/send'));
      await late.deliver(); await response;
      await page.waitForFunction(async focus => (await import('/src/lib/pilotChat.svelte.ts')).chat.focus > focus, focus);
      assert.equal(engine.posts('send').length, 1);
      assert.deepEqual((await ui.users()).filter(t => t === text), [text]);
      assert.equal(await ui.pilot.getAttribute('data-phase'), 'answered');
      assert.equal(await ui.pilot.locator('.queued-inputs').count(), 0, 'the late response does not resurrect a queued input');
      assert.equal(await ui.pilot.locator('.working-status').count(), 0);
      assert.equal(await ui.composer.innerText(), '');
      const trace = await ui.trace();
      assert.equal(trace.userMax[text], 1);
      assert.deepEqual(shown(phasesAfter(trace, 'refreshed'), 'phase'), [], 'nothing changes phase after the authoritative answer');
      const sent = phasesAfter(trace, 'sent');
      assert.ok(!shown(sent.slice(0, sent.findIndex(e => e.kind === 'mark')), 'phase').includes('draft'));
      assert.deepEqual(engine.unexpected, []);
      await ui.context.close();
    }

    // 3. Paused FIFO: an interrupted Pilot holding [image, text].
    {
      const id = pilotId(3), image = { id: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex') + '.png', name: 'field-sketch.png' };
      const s = conversation(id, 'Field sketch');
      Object.assign(s, { phase: 'interrupted', pendingInputs: [
        { id: randomUUID(), text: '', mode: 'text', images: [image] },
        { id: randomUUID(), text: 'Then label the transects.', mode: 'text' },
      ] });
      const ui = await open([s]);
      const { page, engine } = ui;
      const queue = ui.pilot.locator('[aria-label="Queued messages"]');
      const inputs = ui.pilot.locator('.queued-input');
      await inputs.nth(1).waitFor();
      assert.equal(await inputs.nth(0).getByRole('img', { name: 'field-sketch.png' }).count(), 1, 'the image is first');
      assert.deepEqual(await ui.queued(), ['', 'Then label the transects.']);
      assert.equal(await ui.pilot.getAttribute('data-phase'), 'interrupted');
      await ui.mark('queued');
      await ui.type('Also note missing flags.');
      assert.match(await ui.sendButton.textContent(), /Send$/, 'an interrupted Pilot offers Send, not Queue');
      await ui.sendButton.click();
      await inputs.nth(2).waitFor();
      assert.deepEqual(await ui.queued(), ['', 'Then label the transects.', 'Also note missing flags.']);
      assert.equal(engine.posts('resume').length, 0);
      assert.equal(engine.get(id).turn, undefined, 'appending does not resume a stopped queue');
      assert.equal(await ui.pilot.getAttribute('data-phase'), 'interrupted');
      await page.waitForFunction(() => !document.querySelector('.pilot-panel .working-status'));
      assert.equal(await ui.pilot.locator('.message.user').count(), 1);
      await queue.getByRole('button', { name: 'Resume queued messages' }).click();
      await ui.pilot.locator('.message.user').nth(1).getByRole('img', { name: 'field-sketch.png' }).waitFor();
      assert.equal(engine.posts('resume').length, 1);
      assert.deepEqual(await ui.queued(), ['Then label the transects.', 'Also note missing flags.']);
      assert.equal(await ui.pilot.getAttribute('data-phase'), 'working');
      assert.equal(await queue.getByRole('button', { name: 'Resume queued messages' }).count(), 0);
      engine.answer(id, 'The sketch shows three transects.');
      await ui.notify(id); await ui.caughtUp(id);
      assert.deepEqual(await ui.queued(), ['Also note missing flags.']);
      engine.answer(id, 'Transects A to C are labelled.');
      await ui.notify(id); await ui.caughtUp(id);
      assert.deepEqual(await ui.queued(), []);
      await ui.mark('last');
      engine.answer(id, 'Two flags are missing on transect B.');
      await ui.notify(id); await ui.caughtUp(id);
      await ui.pilot.getByText('Two flags are missing on transect B.').waitFor();
      assert.deepEqual(await ui.users(), ['Which survey dates moved?', '', 'Then label the transects.', 'Also note missing flags.']);
      assert.deepEqual(engine.get(id).messages.filter(m => m.role === 'user').map(m => m.images?.[0]?.name ?? m.text),
        ['Which survey dates moved?', 'field-sketch.png', 'Then label the transects.', 'Also note missing flags.']);
      assert.equal(await ui.pilot.getAttribute('data-phase'), 'answered');
      const trace = await ui.trace();
      const waiting = phasesAfter(trace, 'queued').slice(0, phasesAfter(trace, 'queued').findIndex(e => e.kind === 'mark'));
      assert.ok(!shown(waiting, 'phase').some(p => p === 'draft' || p === 'answered'), `queued inputs never read as Draft or answered: ${JSON.stringify(waiting)}`);
      assert.equal(trace.userMax['Also note missing flags.'], 1);
      assert.deepEqual(engine.unexpected, []);
      await ui.context.close();
    }

    // 4. An image upload that never answers is bounded, retryable and never sent.
    {
      const id = pilotId(4);
      const ui = await open([conversation(id, 'Transect photos')], { clock: true });
      const { page, engine } = ui;
      await page.clock.pauseAt(Date.now() + 60_000);
      engine.intercept.image = () => {}; // accepted by the engine, never answered
      const aborted = page.waitForEvent('requestfailed', r => r.url().endsWith('/api/pilot/chat/image'));
      await ui.type('Here is the transect photo.');
      await ui.paste();
      await ui.pilot.getByRole('status').filter({ hasText: 'Attaching image…' }).waitFor();
      assert.equal(await ui.sendButton.isDisabled(), true, 'no send while the image is half uploaded');
      await ui.composer.press('Enter');
      await page.clock.runFor(29_000);
      assert.equal(await ui.pilot.getByText('Attaching image…').count(), 1, 'still within the deadline');
      await page.clock.runFor(1_000);
      await ui.pilot.getByRole('alert').filter({ hasText: 'Image upload timed out. Please try again.' }).waitFor();
      await aborted;
      assert.equal(await ui.pilot.getByRole('button', { name: 'Remove image 1' }).count(), 0);
      assert.equal(engine.posts('send').length, 0);
      assert.equal(await ui.sendButton.isDisabled(), false, 'the text can still be sent; the image can be retried');
      delete engine.intercept.image;
      await ui.paste();
      await ui.pilot.getByRole('button', { name: 'Remove image 1' }).waitFor();
      assert.equal(await ui.pilot.getByText('Image upload timed out. Please try again.').count(), 0);
      const sent = page.waitForResponse(r => r.url().endsWith('/api/pilot/chat/send'));
      await ui.sendButton.click();
      await sent; await ui.caughtUp(id);
      await ui.pilot.locator('.message.user').filter({ hasText: 'Here is the transect photo.' }).getByRole('img', { name: 'field-sketch.png' }).waitFor();
      assert.equal(engine.posts('image').length, 2);
      assert.equal(engine.posts('send').length, 1);
      assert.deepEqual(engine.posts('send')[0].body.images, [engine.posts('image')[1].response]);
      assert.deepEqual(engine.unexpected, []);
      await ui.context.close();
    }

    // 5. The stream stays open but silent while the engine moves on.
    {
      const id = pilotId(5);
      const ui = await open([conversation(id, 'Quiet stream')], { clock: true });
      const { page, engine } = ui;
      await page.clock.pauseAt(Date.now() + 60_000);
      const lists = () => engine.log.filter(e => e.method === 'GET' && e.path === '/api/pilot/chat').length;
      const s = engine.get(id);
      s.messages = [...s.messages, { id: randomUUID(), role: 'assistant', text: 'A late report arrived: the survey dates now agree.', at: now() }];
      s.revision++;
      const before = lists();
      await page.clock.runFor(5_000);
      assert.equal(lists(), before, 'a connected stream suppresses polling');
      assert.equal(await ui.pilot.getByText('the survey dates now agree').count(), 0);
      await page.clock.runFor(30_000);
      await ui.pilot.getByText('A late report arrived: the survey dates now agree.').waitFor();
      assert.ok(lists() > before);
      assert.deepEqual(engine.unexpected, []);
      await ui.context.close();
    }

    assert.deepEqual(errors, []);
    console.log('PASS lost and late send responses reconcile once; paused FIFO appends and resumes in order; image upload timeout is bounded and retryable; silent stream reconciles at 30 s');
  } finally {
    await browser.close();
    rmSync(bundle, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
