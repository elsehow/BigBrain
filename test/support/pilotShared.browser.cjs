/** Browser wiring only: fake microphone, Realtime and shared backend. No model calls. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], inputs = [], speech = []; let voiceUrl, chatUrl, storeUrl, stops = 0;
  const at = new Date().toISOString(), id = 'pilot-' + 'e'.repeat(32), workerId = 'work-' + 'f'.repeat(32);
  const session = { id, title: 'Shared session', model: 'chosen-model', backend: { adapter: 'responses', model: 'chosen-model' }, phase: 'answered', lifecycle: 'active',
   seed: [], context: [], viewRevision: 0, revision: 1, draft: '', messages: [], inputs: [], live: '', activity: '', error: '', created: at, updated: at, lastActivityAt: at };
  const worker = { id: workerId, provider: 'codex', model: 'worker-model', title: 'Arbor agent', status: 'working', origin: { pilot: id, message: 'launch' },
   context: {}, created: at, updated: at, messages: [], receipts: [], vault: '/fixture', cwd: '/fixture' };
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = r.url(); if (u.includes('/src/lib/pilot.svelte.ts')) voiceUrl = u; if (u.includes('/src/lib/pilotChat.svelte.ts')) chatUrl = u; if (u.includes('/src/lib/store.svelte.ts')) storeUrl = u; });
  await page.addInitScript(() => {
   window.voiceCommands = [];
   const track = { readyState: 'live', stop() {} };
   Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) });
   window.RTCPeerConnection = class {
    addTransceiver() { return { sender: { replaceTrack: async () => {} } }; }
    createDataChannel() { const channel = this.channel = { readyState: 'open', send: data => window.voiceCommands.push(JSON.parse(data)), close() {} }; window.voiceWire = { emit: data => channel.onmessage?.({ data: JSON.stringify(data) }) }; return channel; }
    async createOffer() { return { sdp: 'fixture-offer' }; } async setLocalDescription() {}
    async setRemoteDescription() { this.channel.onopen?.(); } close() {}
   };
  });
  await page.route('https://api.openai.com/**', r => r.fulfill({ body: 'fixture-answer' }));
  await page.route('**/api/pilot{,/**}', async route => {
   const path = new URL(route.request().url()).pathname, b = route.request().postDataJSON() ?? {};
   const reply = json => route.fulfill({ json });
   if (path === '/api/pilot') return reply({ configured: true, enabled: true, status: 'ready', model: 'voice-fixture', voice: 'marin' });
   if (path === '/api/pilot/secret') return reply({ value: 'fixture-secret', expires_at: Date.now() / 1000 + 600, model: 'voice-fixture' });
   if (path === '/api/pilot/work') return reply(new URL(route.request().url()).searchParams.has('id') ? worker : { sessions: [worker] });
   if (path === '/api/pilot/chat') return reply({ sessions: [session] });
   if (path.endsWith('/presence')) return reply({ ok: true });
   if (path.endsWith('/spoken')) { speech.push(b.receipt); return reply(session); }
   if (path.endsWith('/stop')) { stops++; return reply(session); }
   if (path.endsWith('/send')) {
    inputs.push(b);
    if (!session.inputs.some(i => i.id === b.inputId)) {
     const m = { id: 'user-' + session.inputs.length, role: 'user', text: b.text, at };
     session.inputs.push({ id: b.inputId, message: m.id, mode: b.mode, text: b.text, target: b.target });
     session.messages.push(m); session.phase = 'working'; session.revision++;
    }
    return reply(session);
   }
   if (path.endsWith('/draft')) { session.draft = b.text; session.revision++; return reply(session); }
   return reply(session);
  });
  await page.route('**/api/graph', r => r.fulfill({ json: { nodes: [], edges: [], hash: 'shared-fixture' } }));
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198');
  await page.locator('.lg-wrap > canvas:not([aria-hidden])').waitFor();
  await page.evaluate(async ({ url, id }) => { const m = await import(url); await m.refreshChats(); m.openChat(id); }, { url: chatUrl, id });
  await page.getByLabel('Message Pilot').waitFor();
  const voice = (name, arg) => page.evaluate(async ({ url, name, arg }) => (await import(url))[name](arg), { url: voiceUrl, name, arg });
  await voice('pilotRefresh'); await voice('pilotPress'); await page.waitForTimeout(300); await voice('pilotRelease');
  const createdBefore = await page.evaluate(() => window.voiceCommands.filter(c => c.type === 'response.create').length);
  assert.equal(createdBefore, 0, 'audio commit cannot trigger an independent answer');
  await page.evaluate(() => {
   const emit = window.voiceWire.emit;
   emit({ type: 'input_audio_buffer.committed', item_id: 'audio-1' });
   emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'audio-1', delta: 'partial' });
   emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'audio-1', transcript: 'What did the evidence say?' });
   emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'audio-1', transcript: 'What did the evidence say?' });
  });
  await page.waitForTimeout(150);
  assert.equal(inputs.length, 1); assert.equal(inputs[0].mode, 'voice'); assert.equal(inputs[0].id, id);
  assert.equal(await page.evaluate(() => window.voiceCommands.filter(c => c.type === 'response.create').length), 0);
  session.messages.push({ id: 'answer-1', role: 'assistant', replyTo: session.messages[0].id, text: 'The evidence is incomplete. No action was taken.', at });
  session.phase = 'answered'; session.revision++;
  await page.waitForFunction(() => window.voiceCommands.some(c => c.type === 'response.create'));
  const playback = await page.evaluate(() => window.voiceCommands.find(c => c.type === 'response.create').response);
  assert.equal(playback.conversation, 'none'); assert.deepEqual(playback.tools, []);
  assert.match(playback.input[0].content[0].text, /incomplete.*No action/);
  await page.evaluate(response => {
   window.voiceWire.emit({ type: 'response.created', response: { id: 'speech-1', metadata: response.metadata } });
   window.voiceWire.emit({ type: 'response.output_audio_transcript.done', response_id: 'speech-1', transcript: 'The evidence is incomplete. No action was taken.' });
   window.voiceWire.emit({ type: 'output_audio_buffer.started', response_id: 'speech-1' });
  }, playback);
  await voice('pilotStop'); await page.waitForTimeout(100);
  assert.equal(stops, 0); assert.equal(worker.status, 'working'); assert.equal(speech[0].status, 'interrupted');
  await page.evaluate(async ({ url, id }) => { const m = await import(url); await m.submitPilotInput(id, 'Follow up by typing', { id: 'typed-followup', mode: 'text' }); }, { url: chatUrl, id });
  assert.equal(inputs[1].id, id); assert.equal(session.messages.filter(m => m.role === 'user').length, 2);
  // Selecting a worker routes speech to that exact worker in its parent Pilot.
  await page.evaluate(async ({ url, path }) => (await import(url)).gotoNote(path), { url: storeUrl, path: 'sessions/' + workerId + '.md' });
  await page.getByRole('region', { name: 'Selected notes' }).waitFor();
  await page.getByRole('region', { name: 'Selected notes' }).locator('[data-agent-state="running"]').waitFor();
  await voice('pilotPress'); await page.waitForTimeout(300); await voice('pilotRelease');
  await page.evaluate(() => { window.voiceWire.emit({ type: 'input_audio_buffer.committed', item_id: 'audio-2' }); window.voiceWire.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'audio-2', transcript: 'Keep the original source links.' }); });
  await page.waitForTimeout(150);
  assert.equal(inputs[2].id, id); assert.equal(inputs[2].target, workerId);
  await voice('pilotDisconnect'); assert.equal(stops, 0);
  assert.deepEqual(errors, []);
  console.log('PASS shared voice/text browser wiring: finalized input, dedupe, confirmed playback, stop-speech isolation, worker routing');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
