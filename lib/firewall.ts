/** The intake firewall. Every arrival is put to a decision model — the
 * Jev/SystemOne API, answered by Cloudflare's Clef on this machine or by a
 * hosted endpoint — BEFORE anything persists it. One yes/no question: does
 * it carry a credential? If that clears its threshold the item is WITHHELD:
 * not landed, not staged, never read by an agent. The one trace it leaves is a metadata
 * line (source, sender, date, reason, scores — never the subject, which is
 * where a one-time code lives) so a false positive can be seen and the
 * threshold tuned (deploy/firewall/eval).
 *
 * The threat this exists for is a password-reset email: an agent that can
 * request a reset and then read the link out of the record owns the
 * account. So the gate fails CLOSED — an unreachable endpoint withholds
 * nothing and admits nothing; the caller retries (a poller leaves the item
 * at its source) or refuses (a drop says so).
 *
 * Only lib/door.ts calls this. No firewall block in vault.yaml means off; a
 * block without a `url` means the app's local model (lib/firewallModel.ts). */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnvelope } from "./envelope";
import { firewallToken } from "./env";
import { ensureDir } from "./fsx";
import { looksBinary, type Attachment } from "./intake";
import { localFirewallUrl } from "./firewallModel";
import { loadManifest, type FirewallConfig } from "./manifest";
import { ensureSpool, spoolDir } from "./spool";

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
// Clef answers a request's questions jointly, so adding one back shifts the
// credential scores: rerun deploy/firewall/eval.
type Question = keyof typeof QUESTIONS;
export type Scores = Record<Question, number>;

export type Verdict =
  | { pass: true; scores?: Scores }
  | { pass: false; reason: Question; scores: Scores };

/** The endpoint could not give an answer. Nothing may pass on it. */
export class FirewallUnavailable extends Error {}
class TooLarge extends Error {}

/** A decision model reads a bounded prompt — Clef's reference code silently
 * drops what is past 16k tokens, llama.cpp refuses what exceeds its batch
 * (8192, bin/firewall-server.ts) — so a long item goes in overlapping windows
 * and its score is the worst window. Windows are characters, the limit is
 * tokens: base64 runs ~0.75 tokens a character, so 8000 characters stays
 * under the batch with room for the schema. A window the server still calls
 * too large is halved and asked again (`askWindow`). */
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

async function ask(cfg: FirewallConfig, state: string, fetchImpl: typeof fetch): Promise<Scores> {
  const url = cfg.url ?? localFirewallUrl();
  const token = firewallToken();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model: cfg.model, state, questions: QUESTIONS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new FirewallUnavailable(`firewall unreachable at ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (/too large/i.test(detail)) throw new TooLarge();
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
async function askWindow(cfg: FirewallConfig, state: string, fetchImpl: typeof fetch): Promise<Scores> {
  try {
    return await ask(cfg, state, fetchImpl);
  } catch (e) {
    if (!(e instanceof TooLarge)) throw e;
    if (state.length <= MIN_WINDOW) throw new FirewallUnavailable(`firewall refused even a ${state.length}-character window as too large`);
    const half = Math.ceil(state.length / 2);
    const a = await askWindow(cfg, state.slice(0, half + OVERLAP / 2), fetchImpl);
    const b = await askWindow(cfg, state.slice(half - OVERLAP / 2), fetchImpl);
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
  // No vault.yaml at all (a scratch root) is no firewall; an unreadable or
  // malformed one throws, so it can never silently turn the firewall off.
  const cfg = existsSync(join(root, "vault.yaml")) ? loadManifest(root).firewall : undefined;
  if (!cfg) return { pass: true };
  const scores: Scores = { credential: 0 };
  for (const state of windows(screenedText(content, attachments))) {
    const s = await askWindow(cfg, state, fetchImpl);
    scores.credential = Math.max(scores.credential, s.credential);
  }
  if (scores.credential >= cfg.thresholds.credential) return { pass: false, reason: "credential", scores };
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
