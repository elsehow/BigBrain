/** Run with the candidate's bundled Bun and bundled engine path. No native launch.
 * Real packaged routes/collectors; synthetic disposable state and mock ingestion. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const engine = resolve(process.argv[2] ?? 'missing-engine');
const bundle = readFileSync(join(engine, 'BUNDLE'), 'utf8').trim();
assert.match(bundle, /^engine [a-f0-9]+/);
const { Telemetry, telemetryRoutes } = await import(join(engine, 'lib/telemetry.ts'));
const { Feedback, feedbackRoutes } = await import(join(engine, 'lib/feedback.ts'));
const { dispatch } = await import(join(engine, 'lib/httpx.ts'));
const root = mkdtempSync(join(tmpdir(), 'bb-packaged-consent-'));
const localFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  assert.equal(url.hostname, '127.0.0.1', 'Only loopback requests permitted');
  return localFetch(input, init);
}) as typeof fetch;
const batches: any[] = [], feedback: any[] = [];
let failFeedback = true;
const collector = new Telemetry({ root, file: join(root, 'consent.json'), token: 'synthetic', region: 'us',
  fetch: async (_url: string, options: RequestInit) => { batches.push(JSON.parse(String(options.body))); return new Response('{}'); } });
const sender = new Feedback({ token: 'synthetic', region: 'us', surveyId: '11111111-1111-4111-8111-111111111111', questionId: '22222222-2222-4222-8222-222222222222',
  fetch: async (_url: string, options: RequestInit) => { feedback.push(JSON.parse(String(options.body))); return new Response('{}', { status: failFeedback ? 502 : 200 }); } });
const routes = [...telemetryRoutes(collector), ...feedbackRoutes(sender)];
const server = createServer((req, res) => { if (!dispatch(routes, req, res)) { res.statusCode = 404; res.end(); } });
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = (path: string, value: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
try {
  assert.equal(collector.snapshot().enabled, false);
  collector.record('search', 100, true); const beforeConsent = collector.begin('graph');
  assert.equal((await post('/api/telemetry', { enabled: false })).status, 200);
  const draft = { id: crypto.randomUUID(), message: 'Synthetic packaged check only', panel: 'home', layout: 'standard', version: '0.7.28' };
  assert.equal((await post('/api/feedback', draft)).status, 502);
  failFeedback = false;
  assert.equal((await post('/api/feedback', draft)).status, 200);
  assert.equal((await post('/api/feedback', draft)).status, 200);
  assert.equal(feedback.length, 2); assert.deepEqual(feedback[0], feedback[1]);
  assert.equal(collector.snapshot().enabled, false); assert.equal(batches.length, 0);
  const event = feedback[0].batch[0];
  assert.equal(event.distinct_id, `feedback-${draft.id}`);
  assert.equal(event.properties.$process_person_profile, false); assert.equal(event.properties.$geoip_disable, true);
  assert.deepEqual(Object.keys(event.properties).sort(), ['$geoip_disable', '$process_person_profile', '$survey_completed', '$survey_id', '$survey_response_22222222-2222-4222-8222-222222222222', '$survey_submission_id', 'app_version', 'layout', 'panel', 'platform'].sort());
  assert.equal((await post('/api/telemetry', { enabled: true })).status, 200);
  beforeConsent(true); collector.summarize(); await collector.flush(); assert.equal(batches.length, 0);
  collector.record('note', 1, true, false); collector.summarize(); await collector.flush();
  assert.equal(batches.length, 1); assert.equal(batches[0].batch[0].properties.operation, 'note_idle');
  assert.notEqual(batches[0].batch[0].distinct_id, event.distinct_id);
  collector.record('search', 1, true); collector.summarize(); assert(collector.snapshot().queued > 0);
  assert.equal((await post('/api/telemetry', { enabled: false })).status, 200);
  assert.equal(collector.snapshot().queued, 0); await collector.flush(); assert.equal(batches.length, 1);
  const restarted = new Telemetry({ root, file: join(root, 'consent.json'), token: 'synthetic', region: 'us' });
  assert.equal(restarted.snapshot().enabled, false); assert.equal(restarted.snapshot().decided, true);
  assert.equal(JSON.parse(readFileSync(join(root, 'consent.json'), 'utf8')).id, undefined);
  console.log(JSON.stringify({ result: 'PASS', bundle, runtime: process.execPath, ingestion: 'mocked', realNetwork: 'loopback only', nativeWindow: 'not tested', checks: ['default off', 'independent feedback', 'failure/retry/deduplication', 'metadata allowlist', 'separate identifiers', 'no pre-consent backfill', 'withdrawal clears queue', 'restart persistence'] }, null, 2));
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  globalThis.fetch = localFetch; rmSync(root, { recursive: true, force: true });
}
