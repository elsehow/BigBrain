/** The intake firewall. Every arrival is put to Jev (TypeSafe's SystemOne
 * API, lib/sharedJev.ts) BEFORE anything lands or stages it; until then it
 * waits in the sealed arrivals queue (lib/arrivals.ts). One yes/no question:
 * does it carry a credential? If that clears its threshold the item is
 * WITHHELD: not landed, not staged, never read by an agent. The one trace it
 * leaves is a metadata line (source, sender, date, reason, scores — never the
 * subject, which is where a one-time code lives) so a false positive can be
 * seen and the threshold tuned (deploy/firewall/eval).
 *
 * The threat this exists for is a password-reset email: an agent that can
 * request a reset and then read the link out of the record owns the
 * account. So the gate fails CLOSED — an unreachable endpoint withholds
 * nothing and admits nothing; the arrival stays queued, and lands once the
 * endpoint answers (lib/door.ts).
 *
 * On whenever a Jev key is set (the one key store, lib/jevSettings.ts),
 * unless the owner turned it off (`security.firewall: false`); with no key it
 * is off. It is decided per arrival, so a key added before an integration's
 * first poll screens that poll. Only lib/door.ts calls this. */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnvelope } from "./envelope";
import { firewallUrl } from "./env";
import { ensureDir } from "./fsx";
import { looksBinary, type Attachment } from "./intake";
import { optionalJevKey } from "./jevSettings";
import { loadManifest } from "./manifest";
import { connectionStorePath } from "./sharedConnections";
import { JEV_MODEL, JEV_URL } from "./sharedJev";
import { ensureSpool, spoolDir } from "./spool";
import { OutOfCredits, outOfCredits, withCredits } from "./providerCredits";

/** The Jev key the firewall screens with, or undefined when it is off for
 * this vault: no vault.yaml (a scratch root), turned off, or no key. An
 * unreadable vault.yaml or key store throws, so it can never silently turn
 * the firewall off. */
export function firewallKey(root: string): string | undefined {
  if (!existsSync(join(root, "vault.yaml"))) return undefined;
  if (loadManifest(root).security.firewall === false) return undefined;
  return optionalJevKey(connectionStorePath());
}

/** A missed reset link is the costly error, so the threshold sits just under
 * the weakest credential mail in deploy/firewall/eval (Jev, 2026-10-06:
 * credential ≥ 0.42, ordinary ≤ 0.09). 0.15 withheld ordinary web clips at
 * 0.20–0.24; rerun the eval before moving it. */
export const FIREWALL_THRESHOLD = 0.4;

export const QUESTIONS = {
  credential: {
    type: "noul",
    instructions:
      "Does this item contain a live secret that would grant access to an account: a password, " +
      "passphrase, API key, access token, private key, one-time or verification code, 2FA backup " +
      "codes, or a password-reset, magic sign-in, or account-verification link?",
  },
} as const;
// A second question, "is this malicious?", withheld genuine payment and
// account mail at the rate it caught phishing (0.89–0.91 on real payment and
// brokerage notices); it was removed until it can be evaluated on real mail.
// A model may answer a request's questions jointly, so adding one back can
// shift the credential scores: rerun deploy/firewall/eval.
type Question = keyof typeof QUESTIONS;
export type Scores = Record<Question, number>;

export type Verdict =
  | { pass: true; scores?: Scores }
  | { pass: false; reason: Question; scores: Scores };

/** The endpoint could not give an answer. Nothing may pass on it. */
export class FirewallUnavailable extends Error {}
class TooLarge extends Error {}

/** A decision model reads a bounded prompt, so a long item goes in
 * overlapping windows and its score is the worst window. Windows are
 * characters, the limit is tokens: base64 runs ~0.75 tokens a character. A
 * window the endpoint still calls too large is halved and asked again
 * (`askWindow`). */
const WINDOW = 8_000;
const OVERLAP = 800;
const MIN_WINDOW = 500;
const TIMEOUT_MS = 180_000;

export function windows(text: string): string[] {
  if (text.length <= WINDOW) return [text];
  const out: string[] = [];
  for (let at = 0; at < text.length; at += WINDOW - OVERLAP) {
    out.push(text.slice(at, at + WINDOW));
    if (at + WINDOW >= text.length) break;
  }
  return out;
}

/** What the model reads: the item whole, plus every attachment that is
 * text (a forwarded `.eml` carries its reset link in exactly this way).
 * Binary attachments are not read. */
export function screenedText(content: string, attachments: readonly Attachment[] = []): string {
  const parts = [content];
  for (const a of attachments) {
    const bytes = Buffer.from(a.b64, "base64");
    if (!looksBinary(a.name, bytes)) parts.push(`--- attachment: ${a.name}\n${bytes.toString("utf8")}`);
  }
  return parts.join("\n\n");
}

async function ask(key: string, state: string, fetchImpl: typeof fetch): Promise<Scores> {
  const url = firewallUrl() ?? JEV_URL;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: QUESTIONS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new FirewallUnavailable(`firewall unreachable at ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 413 || /too large/i.test(detail)) throw new TooLarge();
    if (outOfCredits(res.status, detail)) throw new OutOfCredits("typesafe", detail.slice(0, 300));
    throw new FirewallUnavailable(`firewall answered ${res.status} at ${url}`);
  }
  const body = (await res.json().catch(() => undefined)) as { answers?: Record<string, { noul?: unknown }> } | undefined;
  const score = (q: Question): number => {
    const p = body?.answers?.[q]?.noul;
    if (typeof p !== "number" || !(p >= 0 && p <= 1)) throw new FirewallUnavailable(`firewall gave no ${q} probability`);
    return p;
  };
  return { credential: score("credential") };
}

/** Ask about one window; one the server refuses as too large is split in
 * two overlapping halves, each asked, the worst score kept. */
async function askWindow(key: string, state: string, fetchImpl: typeof fetch): Promise<Scores> {
  try {
    return await ask(key, state, fetchImpl);
  } catch (e) {
    if (!(e instanceof TooLarge)) throw e;
    if (state.length <= MIN_WINDOW) throw new FirewallUnavailable(`firewall refused even a ${state.length}-character window as too large`);
    const half = Math.ceil(state.length / 2);
    const a = await askWindow(key, state.slice(0, half + OVERLAP / 2), fetchImpl);
    const b = await askWindow(key, state.slice(half - OVERLAP / 2), fetchImpl);
    return { credential: Math.max(a.credential, b.credential) };
  }
}

/** Screen one arrival. `pass: true` with no scores means the firewall is
 * off for this vault. Throws FirewallUnavailable rather than guess. */
export async function screen(
  root: string,
  content: string,
  attachments: readonly Attachment[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<Verdict> {
  const key = firewallKey(root);
  if (!key) return { pass: true };
  const scores: Scores = { credential: 0 };
  try {
    // a hosted firewall can run out of credits: noted (the base says so), and still unavailable — closed
    await withCredits(root, "typesafe", "firewall", async () => {
      for (const state of windows(screenedText(content, attachments))) {
        const s = await askWindow(key, state, fetchImpl);
        scores.credential = Math.max(scores.credential, s.credential);
      }
    });
  } catch (e) {
    if (e instanceof OutOfCredits) throw new FirewallUnavailable("firewall: out of usage credits");
    throw e;
  }
  if (scores.credential >= FIREWALL_THRESHOLD) return { pass: false, reason: "credential", scores };
  return { pass: true, scores };
}

export const withheldLog = (root: string): string => join(spoolDir(root), "firewall", "withheld.jsonl");

/** The withheld item's one trace. Deliberately no subject, title or body. */
export function recordWithheld(root: string, source: string, content: string, verdict: Extract<Verdict, { pass: false }>, now = new Date()): void {
  let envelope: Record<string, unknown> = {};
  try { envelope = parseEnvelope(content).envelope; } catch { /* a bare note has no envelope */ }
  const line = {
    at: now.toISOString(),
    source,
    ...(typeof envelope.from === "string" ? { from: envelope.from } : {}),
    ...(typeof envelope.date === "string" ? { date: envelope.date } : {}),
    reason: verdict.reason,
    scores: verdict.scores,
  };
  ensureSpool(root);
  ensureDir(join(spoolDir(root), "firewall"));
  appendFileSync(withheldLog(root), JSON.stringify(line) + "\n");
}
