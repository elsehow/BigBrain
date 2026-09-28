import { createHash } from 'node:crypto';
import { allowLoopbackRequest, json, readBody, type Route } from './httpx';
import { feedbackConfig } from './feedbackConfig';
import { FEEDBACK_LIMIT, FEEDBACK_PANELS, type FeedbackInput } from './feedbackSchema';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const targets = { us: 'https://us.i.posthog.com/batch/', eu: 'https://eu.i.posthog.com/batch/' };
class FeedbackError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function input(value: unknown): FeedbackInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FeedbackError(400, 'Check your feedback and try again.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['id', 'message', 'panel', 'layout', 'version'].includes(k))
      || typeof v.id !== 'string' || !uuid.test(v.id)
      || typeof v.message !== 'string' || !v.message.trim() || v.message.length > FEEDBACK_LIMIT
      || !FEEDBACK_PANELS.includes(v.panel as FeedbackInput['panel'])
      || !['standard', 'expanded'].includes(v.layout as string)
      || typeof v.version !== 'string' || !/^(?:unknown|\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,32})?)$/.test(v.version))
    throw new FeedbackError(400, 'Enter feedback of 1–4,000 characters and try again.');
  return { id: v.id, message: v.message.trim(), panel: v.panel as FeedbackInput['panel'], layout: v.layout as FeedbackInput['layout'], version: v.version };
}

/** Explicit submissions only. No telemetry collector, installation identity,
 * background retries, disk drafts, SDK, automatic context, or replay. */
export class Feedback {
  private receipts = new Map<string, { hash: string; timestamp: string; sent: boolean }>();
  private busy = false;
  constructor(private options: { token: string; region: 'us' | 'eu'; surveyId: string; questionId: string; fetch?: typeof fetch; timeoutMs?: number }) {}
  get configured(): boolean { return !!this.options.token && uuid.test(this.options.surveyId) && uuid.test(this.options.questionId) && !!targets[this.options.region]; }
  async submit(raw: unknown): Promise<void> {
    const value = input(raw);
    if (!this.configured) throw new FeedbackError(503, 'Feedback delivery is not set up yet. Keep this draft and try after updating BigBrain.');
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    let receipt = this.receipts.get(value.id);
    if (receipt && receipt.hash !== hash) throw new FeedbackError(409, 'This submission changed. Close and reopen the form, then try again.');
    if (receipt?.sent) return;
    if (this.busy) throw new FeedbackError(429, 'Another feedback submission is sending. Please try again in a moment.');
    if (!receipt) {
      if (this.receipts.size >= 100) this.receipts.delete(this.receipts.keys().next().value!);
      receipt = { hash, timestamp: new Date().toISOString(), sent: false };
      this.receipts.set(value.id, receipt);
    }
    this.busy = true;
    try {
      const response = await (this.options.fetch ?? fetch)(targets[this.options.region], {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: this.options.token, batch: [{
          uuid: value.id, distinct_id: `feedback-${value.id}`, event: 'survey sent', timestamp: receipt.timestamp,
          properties: {
            $survey_id: this.options.surveyId, [`$survey_response_${this.options.questionId}`]: value.message,
            $survey_submission_id: value.id, $survey_completed: true,
            $process_person_profile: false, $geoip_disable: true,
            app_version: value.version, platform: process.platform, panel: value.panel, layout: value.layout,
          },
        }] }),
      });
      if (!response.ok) throw new Error('delivery failed');
      receipt.sent = true;
    } catch {
      throw new FeedbackError(502, 'Could not send feedback. Check your connection and try again. Your draft is still here.');
    } finally { this.busy = false; }
  }
}
export function feedbackRoutes(sender = new Feedback(feedbackConfig)): Route[] {
  return [{ method: 'POST', path: '/api/feedback', handler: ({ req, res }) => {
    if (!allowLoopbackRequest(req, res)) return;
    if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return json(res, 415, { error: 'JSON required' });
    void (async () => {
      let value: unknown;
      try { value = JSON.parse(await readBody(req, 20_000)); }
      catch { return json(res, 400, { error: 'Could not read feedback. Shorten your message and try again.' }); }
      try { await sender.submit(value); json(res, 200, { ok: true }); }
      catch (error) { json(res, error instanceof FeedbackError ? error.status : 500, { error: error instanceof FeedbackError ? error.message : 'Could not send feedback. Please try again.' }); }
    })();
  } }];
}
