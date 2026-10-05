/**
 * providerCredits.ts — when a model provider says the account is out of usage
 * credits (or past its plan's usage limit), the engine remembers it here, per
 * provider, so every surface can say so once instead of each job failing
 * silently: the base shows a banner, and the gardener pauses rather than pay
 * for a failed attempt every five minutes. Nothing is dropped meanwhile: what
 * arrives waits in the stage, and integrations retry at the door.
 *
 * A mark clears on the provider's next successful call, or when the owner
 * presses Retry (POST /api/credits/retry). Local state (.state/credits.json):
 * per machine, never committed.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeAtomic } from "./fsx";

/** Whether a provider's error reads as an exhausted balance or usage limit
 * (a 402, or words to that effect), not merely a source that mentions credits. */
export const outOfCredits = (status: number, text: string): boolean =>
  status === 402 || /out of (usage )?credits|credit balance|(insufficient|no|exhausted) (usage )?credits|credits? (are |is )?exhausted|insufficient[ _](funds|balance|quota)|quota exceeded|payment required|usage limit (reached|exceeded)|(hit|reached) your usage limit/i.test(text);

/** A provider is out of usage credits: not the input's fault, and no retry
 * goes better until the account is topped up or its limit resets. */
export class OutOfCredits extends Error {
  constructor(readonly provider = "", readonly detail = "") {
    super("Out of usage credits.");
    this.name = "OutOfCredits";
  }
}

/** `since`: the first failure; `at`: the latest (a probe that failed again). */
export interface CreditsMark { since: string; at: string; roles: string[]; detail: string }
export type CreditsState = Record<string, CreditsMark>;

const path = (root: string) => join(root, ".state", "credits.json");

export function creditsState(root: string): CreditsState {
  try {
    const raw = JSON.parse(readFileSync(path(root), "utf8")) as CreditsState;
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}
function write(root: string, state: CreditsState): void {
  if (!Object.keys(state).length) { rmSync(path(root), { force: true }); return; }
  ensureDir(join(root, ".state"));
  writeAtomic(path(root), JSON.stringify(state, null, 2) + "\n");
}

/** `role` (the gardener, the firewall, …) found `provider` out of credits. */
export function noteOutOfCredits(root: string, provider: string, role: string, detail: string, now = new Date()): void {
  const state = creditsState(root), mark = state[provider];
  state[provider] = { since: mark?.since ?? now.toISOString(), at: now.toISOString(), roles: [...new Set([...(mark?.roles ?? []), role])], detail: detail.slice(0, 300) };
  write(root, state);
}
/** A call to `provider` went through: it has credits again. */
export function noteCreditsOk(root: string, provider: string): void {
  if (!existsSync(path(root))) return;
  const state = creditsState(root);
  if (!state[provider]) return;
  delete state[provider];
  write(root, state);
}
/** The owner topped up: try everything again now. */
export function clearCredits(root: string): void { write(root, {}); }

/** How long a paused job waits before trying once more on its own (a plan's
 * usage limit resets; a top-up can happen without anyone pressing Retry). */
export const CREDITS_PROBE_MS = 30 * 60_000;
/** Whether jobs on `provider` should hold off for now. */
export function creditsPaused(root: string, provider: string, now = Date.now()): boolean {
  const mark = creditsState(root)[provider];
  return !!mark && now - Date.parse(mark.at) < CREDITS_PROBE_MS;
}

/** Run a provider call, noting the result: out of credits marks it (and
 * throws OutOfCredits), success clears it. */
export async function withCredits<T>(root: string, provider: string, role: string, call: () => Promise<T>): Promise<T> {
  try {
    const out = await call();
    noteCreditsOk(root, provider);
    return out;
  } catch (e) {
    const detail = e instanceof OutOfCredits ? e.detail : e instanceof Error ? e.message : String(e);
    if (e instanceof OutOfCredits || outOfCredits(0, detail)) {
      noteOutOfCredits(root, provider, role, detail);
      throw e instanceof OutOfCredits ? e : new OutOfCredits(provider, detail);
    }
    throw e;
  }
}
