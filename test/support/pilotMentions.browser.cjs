/** Live UI with fabricated API responses; no model requests or vault writes. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let chatUrl;
  page.on('request', r => { if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
  const current = 'pilot-' + 'a'.repeat(32), other = 'pilot-' + 'b'.repeat(32);
  const at = new Date().toISOString();
  const session = id => ({ id, title: id === current ? 'Current session' : 'Earlier Pilot', model: 'gpt-5.6-terra', phase: 'answered', lifecycle: 'active', seed: [], context: [], viewRevision: 0, revision: 1, draft: '', messages: [{ id: 'm', role: 'assistant', text: 'An earlier answer.', at }], live: '', activity: '', error: '', created: at, updated: at });
  const sessions = [session(current), session(other)]; const searches = []; const sent = [];
  let releaseContext, contextEntered;
  const contextGate = new Promise(resolve => { releaseContext = resolve; });
  const contextStarted = new Promise(resolve => { contextEntered = resolve; });
  let holdContext = true;
  await page.route('**/api/graph', r => r.fulfill({ json: { nodes: [{ id: 'recent-note', path: 'memory/recent', title: 'Recent memory', group: 'memory', x: 0, y: 0, degree: 1 }], edges: [], hash: 'mentions-test' } }));
  await page.route('**/api/recent?**', r => r.fulfill({ json: { recent: [
   { path: 'memory/recent', title: 'Recent memory', modified: Date.now() },
   { path: 'source/atlas-call', title: 'ATLAS call notes', modified: Date.now() },
   { path: 'source/current-chapter', title: 'Current session', from: 'pilot', sessionId: current, modified: Date.now() },
  ], nextOffset: null } }));
  await page.route('**/api/search?**', async r => {
   const q = new URL(r.request().url()).searchParams.get('q'); searches.push(q);
   if (q === 'slow') await new Promise(resolve => setTimeout(resolve, 600));
   if (q === 'failure') return r.fulfill({ status: 500, json: { error: 'Test failure' } });
   return r.fulfill({ json: { hits: q === 'none' ? [] : [
    { dir: 'source', note: { path: 'source/' + q, name: q, modified: Date.now(), size: 1 }, title: q + ' outside recents', snippet: '' },
    { dir: 'source', sessionId: current, from: 'pilot', note: { path: 'source/current-chapter', name: 'current', modified: Date.now(), size: 1 }, title: 'Current session', snippet: '' },
   ], nextOffset: null } });
  });
  await page.route('**/api/pilot/chat{,/**}', async r => {
   const action = new URL(r.request().url()).pathname.split('/').at(-1), b = r.request().postDataJSON() ?? {};
   if (action === 'chat') return r.fulfill({ json: { sessions } });
   if (action === 'presence') return r.fulfill({ json: { ok: true } });
   const s = sessions.find(s => s.id === b.id);
   if (action === 'context-add') {
    if (holdContext) { contextEntered(); await contextGate; holdContext = false; }
    s.context = [...new Set([...s.context, ...b.nodes])]; s.viewRevision++;
    s.contextNodes = s.context.filter(id => !id.startsWith('pilot-')).map(id => ({ id, path: id, title: id.split('/').at(-1) + ' outside recents', group: 'source' }));
   }
   if (action === 'draft') s.draft = b.text;
   if (action === 'send') { sent.push(b.text); s.draft = ''; s.messages.push({ id: 'u' + sent.length, role: 'user', text: b.text, at }); }
   s.revision++; return r.fulfill({ json: s });
  });
  await page.goto(base);
  const open = () => page.evaluate(async ({ url, current }) => { const mod = await import(url); await mod.refreshChats(); mod.openChat(current); }, { url: chatUrl, current });
  await open();
  const input = page.getByRole('textbox', { name: 'Message Pilot' });
  const panel = page.getByRole('region', { name: 'Pilot text tab' });
  assert.equal(await panel.getByRole('button', { name: 'Model', exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Change model (gpt-5.6-terra)', exact: true }).textContent(), 'gpt-5.6-terra');
  await input.fill('@');
  await page.getByRole('option').filter({ hasText: 'Recent memory' }).waitFor();
  assert.equal(await page.getByRole('option').filter({ hasText: 'Current session' }).count(), 0);
  assert.equal(await page.getByRole('option').filter({ hasText: 'Earlier Pilot' }).count(), 1);
  const initiallySelected = await page.getByRole('option', { selected: true }).textContent();
  await page.keyboard.press('ArrowDown');
  assert.notEqual(await page.getByRole('option', { selected: true }).textContent(), initiallySelected);
  assert.equal(searches.length, 0); // Bare @ and keyboard browsing remain recents.
  await page.keyboard.type('Recent');
  await page.getByRole('option').filter({ hasText: 'Recent outside recents' }).waitFor();
  assert.equal(await page.getByRole('option').filter({ hasText: 'Recent memory' }).count(), 0);
  await page.keyboard.press('Enter'); assert.equal(await input.locator('[data-mention="source/Recent"]').count(), 1);
  await contextStarted;
  const immediate = await page.evaluate(async url => {
    const mod = await import(url), { withPilotChats } = await import('/src/lib/pilotChatGraph.ts');
    const s = mod.activeChat(), graph = withPilotChats(mod.chat.graph, mod.chatSessions(), s.id);
    return { context: s.context, linked: graph.edges.some(e => e.source === 'source/Recent' && e.target === s.id && e.pilotContext) };
  }, chatUrl);
  assert.ok(immediate.context.includes('source/Recent')); assert.equal(immediate.linked, true);
  assert.equal(sessions[0].context.length, 0); // Visible connection precedes server acknowledgement.
  releaseContext();
  await page.keyboard.type(' compare @'); await page.keyboard.type('beyond');
  await page.getByRole('option').filter({ hasText: 'beyond outside recents' }).waitFor();
  assert.deepEqual(searches, ['Recent', 'beyond']);
  assert.equal(await page.getByRole('option').filter({ hasText: 'Current session' }).count(), 0);
  await page.keyboard.press('Enter'); assert.equal(await input.locator('[data-mention]').count(), 2);
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Keep both references.');
  await page.keyboard.press('Escape'); await input.waitFor({ state: 'detached' });
  await open(); await input.waitFor(); assert.equal(await input.locator('[data-mention]').count(), 2);
  const submitted = page.waitForResponse('**/api/pilot/chat/send');
  await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.querySelector('[aria-label="Message Pilot"]').textContent);
  await submitted;
  assert.ok(sessions[0].context.includes('source/Recent')); assert.ok(sessions[0].context.includes('source/beyond'));
  await page.locator('.sent-mention').first().waitFor();
  assert.equal(await page.locator('.sent-mention').count(), 2);
  assert.match(sent[0], /\[\[source\/Recent\|Recent outside recents\]\]/);
  assert.match(sent[0], /\[\[source\/beyond\|beyond outside recents\]\]/);
  assert.ok(sent[0].includes('\nKeep both references.'));
  // A matching recent ATLAS call must not hide the broader vault result.
  await input.fill('@atlas');
  await page.getByRole('option').filter({ hasText: 'atlas outside recents' }).waitFor();
  assert.equal(await page.getByRole('option').filter({ hasText: 'ATLAS call notes' }).count(), 0);
  await input.fill('@');
  await page.getByRole('option').filter({ hasText: 'ATLAS call notes' }).waitFor();
  // Replacing a request never paints or inserts the stale result.
  await input.fill('@slow'); await page.waitForTimeout(150); await input.fill('@newer');
  await page.getByRole('option').filter({ hasText: 'newer outside recents' }).waitFor(); await page.waitForTimeout(650);
  assert.equal(await page.getByRole('option').filter({ hasText: 'slow outside recents' }).count(), 0);
  await page.keyboard.press('Escape'); assert.equal(await input.count(), 1); assert.equal(await page.getByRole('listbox').count(), 0);
  await input.fill('@none'); await page.getByRole('status').filter({ hasText: 'No matching items' }).waitFor();
  await page.keyboard.press('Escape'); await input.fill('@failure'); await page.getByRole('status').filter({ hasText: 'Search failed' }).waitFor();
  await page.keyboard.press('Escape'); await input.fill('One line');
  await input.evaluate(el => { const r = document.createRange(); r.setStart(el.firstChild, 3); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.evaluate(async url => { (await import(url)).chat.focus++; }, chatUrl);
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => getSelection().anchorOffset), 3);
  sessions[0].messages[0].text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}. More conversation history.`).join('\n\n');
  sessions[0].revision++; await open();
  const small = await panel.boundingBox(), ih = (await input.boundingBox()).height;
  const background = await page.locator('.chat-drawer .sheet').evaluate(el => getComputedStyle(el).backgroundColor);
  await page.keyboard.press('Shift+ArrowUp'); await page.waitForTimeout(300);
  const tall = await panel.boundingBox(); assert.ok(tall.height > small.height + 200); assert.equal((await input.boundingBox()).height, ih);
  assert.equal(await page.locator('.chat-drawer .sheet').evaluate(el => getComputedStyle(el).backgroundColor), background);
  // Backend polling must not reset expansion.
  sessions[0].revision++; await page.waitForTimeout(1700); assert.equal((await panel.boundingBox()).height, tall.height);
  await page.screenshot({ path: '/tmp/pilot-live-mentions-expanded.png' });
  await page.keyboard.press('Shift+ArrowUp'); await page.waitForTimeout(300); assert.equal((await panel.boundingBox()).height, tall.height);
  await page.locator('.pilot-panel .transcript').evaluate(el => { el.scrollTop = 0; });
  const collapseFrames = await page.evaluate(async () => {
    const drawer = document.querySelector('.chat-drawer'), transcript = document.querySelector('.pilot-panel .transcript');
    const frames = [], start = performance.now();
    document.querySelector('[aria-label="Message Pilot"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    await new Promise(resolve => {
      function sample() {
        frames.push({ time: performance.now() - start, height: drawer.getBoundingClientRect().height, remaining: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight });
        if (performance.now() - start < 350) requestAnimationFrame(sample); else resolve();
      }
      requestAnimationFrame(sample);
    });
    return frames;
  });
  // No immediate collapsed max-height clamp, and no delayed scroll jump at finish.
  assert.ok(collapseFrames[0].height > tall.height - 100, JSON.stringify(collapseFrames));
  assert.ok(collapseFrames.filter(f => f.time >= 220).every(f => f.remaining < 30), JSON.stringify(collapseFrames));
  assert.equal((await panel.boundingBox()).height, small.height);
  assert.ok(await page.locator('.pilot-panel .transcript').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 2));
  await page.keyboard.press('Shift+ArrowUp'); await page.waitForTimeout(70);
  await page.keyboard.press('Shift+ArrowDown'); await page.waitForTimeout(350);
  assert.equal((await panel.boundingBox()).height, small.height);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Shift+ArrowUp'); await page.keyboard.press('Shift+ArrowDown');
  assert.equal((await panel.boundingBox()).height, small.height);
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Another line'); }
  assert.ok((await input.boundingBox()).height <= 150);
  assert.equal(await page.getByRole('button', { name: '⇧Esc Stop', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'End session', exact: true }).count(), 1);
  // An older still-running engine can use revision-checked context replacement.
  let replacements = 0;
  await page.route('**/api/pilot/chat/context-add', r => r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
  await page.route('**/api/pilot/chat/context', r => {
   const b = r.request().postDataJSON(), s = sessions[0];
   if (++replacements === 1) {
    s.context.push('concurrent-context'); s.viewRevision++; s.revision++;
    return r.fulfill({ status: 409, json: { error: 'Context changed' } });
   }
   assert.equal(b.expectedRevision, s.viewRevision);
   assert.equal(b.title, s.title);
   s.context = b.nodes; s.viewRevision++; s.revision++;
   return r.fulfill({ json: s });
  });
  await page.evaluate(async ({ url, current }) => (await import(url)).addChatContext(current, ['legacy-context']), { url: chatUrl, current });
  assert.equal(replacements, 2);
  assert.ok(sessions[0].context.includes('concurrent-context'));
  assert.ok(sessions[0].context.includes('legacy-context'));
  assert.deepEqual(errors, []);
  console.log('PASS live mentions: recents → search, exclusion, stale cancellation, draft restore, send, Escape, errors, fixed tab heights and bounded composer');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
