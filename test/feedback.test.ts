import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Feedback, feedbackRoutes } from '../lib/feedback';
import { dispatch } from '../lib/httpx';
import { Telemetry } from '../lib/telemetry';

const config = { token: 'synthetic-token', region: 'us' as const, surveyId: '11111111-1111-4111-8111-111111111111', questionId: '22222222-2222-4222-8222-222222222222' };
const draft = () => ({ id: crypto.randomUUID(), message: 'Synthetic feedback only', panel: 'home', layout: 'standard', version: '0.7.28' });
function setup(send?: typeof fetch) {
  const bodies: any[] = [];
  const sender = new Feedback({ ...config, fetch: send ?? (async (url, options) => {
    expect(url).toBe('https://us.i.posthog.com/batch/');
    bodies.push(JSON.parse(options!.body as string));
    return new Response('{}');
  }) as typeof fetch });
  return { sender, bodies };
}
describe('explicit feedback', () => {
  test('only intentional text and allowlisted metadata leave, with analytics disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-feedback-'));
    try {
      const telemetry = new Telemetry({ root, file: join(root, 'consent.json'), ...config, fetch: (() => { throw new Error('Analytics must not send'); }) as unknown as typeof fetch });
      telemetry.setConsent(false);
      const { sender, bodies } = setup(); const value = draft();
      await sender.submit(value);
      expect(telemetry.snapshot()).toMatchObject({ enabled: false, queued: 0 });
      const event = bodies[0].batch[0];
      expect(event).toMatchObject({ event: 'survey sent', uuid: value.id, distinct_id: `feedback-${value.id}` });
      expect(event.properties).toEqual({
        $survey_id: config.surveyId, [`$survey_response_${config.questionId}`]: value.message,
        $survey_submission_id: value.id, $survey_completed: true,
        $process_person_profile: false, $geoip_disable: true,
        app_version: '0.7.28', platform: process.platform, panel: 'home', layout: 'standard',
      });
      expect(JSON.stringify(bodies)).not.toContain(root);
      await telemetry.flush();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('rejects empty, oversized, arbitrary context and identifiers before delivery', async () => {
    const { sender, bodies } = setup();
    for (const change of [{ message: '   ' }, { message: 'x'.repeat(4001) }, { panel: 'Private note title' }, { version: '/private/vault' }, { layout: 'private' }, { id: 'bad' }, { vault: 'private' }, { ip: '192.0.2.1' }, { $ip: '192.0.2.1' }]) {
      await expect(sender.submit({ ...draft(), ...change })).rejects.toMatchObject({ status: 400 });
    }
    expect(bodies).toHaveLength(0);
  });
  test('unconfigured survey fails closed, success deduplicates, and changed retries conflict', async () => {
    const { sender, bodies } = setup(); const value = draft();
    await expect(new Feedback({ ...config, surveyId: '' }).submit(value)).rejects.toMatchObject({ status: 503 });
    await sender.submit(value); await sender.submit(value);
    expect(bodies).toHaveLength(1);
    await expect(sender.submit({ ...value, message: 'Changed' })).rejects.toMatchObject({ status: 409 });
  });
  test('concurrent sends are bounded and failed retries preserve event identity', async () => {
    const bodies: any[] = []; let finish!: (r: Response) => void;
    const sender = new Feedback({ ...config, fetch: (async (_url, options) => {
      bodies.push(JSON.parse(options!.body as string));
      return new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch });
    const value = draft(); const first = sender.submit(value);
    await expect(sender.submit(value)).rejects.toMatchObject({ status: 429 });
    finish(new Response('{}', { status: 503 }));
    await expect(first).rejects.toMatchObject({ status: 502 });
    const retry = sender.submit(value); finish(new Response('{}')); await retry;
    expect(bodies[1]).toEqual(bodies[0]);
  });
  test('offline and timeout failures are actionable and retryable', async () => {
    const { sender } = setup((async () => { throw new TypeError('offline'); }) as typeof fetch);
    await expect(sender.submit(draft())).rejects.toThrow('Check your connection');
    const stalled = new Feedback({ ...config, timeoutMs: 5, fetch: ((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('timeout')));
    })) as typeof fetch });
    await expect(stalled.submit(draft())).rejects.toMatchObject({ status: 502 });
  });
  test('route requires local JSON, returns errors and an explicit success receipt', async () => {
    const { sender, bodies } = setup(); const routes = feedbackRoutes(sender);
    const server = createServer((req, res) => { dispatch(routes, req, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/feedback`;
    try {
      const post = (body: string, headers = { 'content-type': 'application/json' }) => fetch(url, { method: 'POST', headers, body });
      expect((await post(JSON.stringify(draft()), { 'content-type': 'text/plain' })).status).toBe(415);
      expect((await fetch(url, { method: 'POST', headers: { origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify(draft()) })).status).toBe(403);
      expect((await post('{')).status).toBe(400);
      expect((await post(JSON.stringify({ ...draft(), message: '' }))).status).toBe(400);
      expect(bodies).toHaveLength(0);
      expect(await (await post(JSON.stringify(draft()))).json()).toEqual({ ok: true });
      expect(bodies).toHaveLength(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
