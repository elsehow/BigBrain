/** A poll's health is independent of whether it found anything. These
 * receipts are disposable; credentials and remote response bodies never ride
 * them. Settings reads them without opening a poller's private cursor. */
import { join } from "node:path";
import { writeAtomic } from "./fsx";
import { readCursorJson } from "./integrationCursor";

/** What kind of failure a poll hit, from a fixed list, so Settings and the
 * main view can tell "will pass" from "needs you" and telemetry can count it
 * without a message. Only `reconnect` and `credentials` need the person. */
export const POLL_ERROR_CODES = ["reconnect", "credentials", "format", "network", "provider", "unknown"] as const;
export type PollErrorCode = typeof POLL_ERROR_CODES[number];
export const needsAction = (code: PollErrorCode | undefined): boolean => code === "reconnect" || code === "credentials";

export interface PollStatus {
  state: "checking" | "importing" | "ok" | "error";
  at: string;
  checkedAt?: string;
  lastArrivalAt?: string;
  detail?: string;
  code?: PollErrorCode;
  /** Polls in a row that have failed, and when the first of them did. */
  failures?: number;
  failingSince?: string;
}
export interface IntegrationStatus {
  state: "off" | "unset" | "waiting" | PollStatus["state"];
  label: string;
  checkedAt?: string;
  lastArrivalAt?: string;
  code?: PollErrorCode;
  needsAction?: boolean;
  failingSince?: string;
}
/** A failure whose message Settings may show as it is. */
export class PollError extends Error {
  constructor(message: string, readonly code: PollErrorCode = "provider") { super(message); }
}
/** The code for anything a poll throws. A connection that never opened or
 * timed out is `network`; what else isn't a PollError is `unknown`. */
export function pollErrorCode(error: unknown): PollErrorCode {
  if (error instanceof PollError) return error.code;
  const e = error as { name?: unknown; code?: unknown } | null | undefined;
  if (e?.name === "TimeoutError") return "network";
  return typeof e?.code === "string" && /^(Connection|FailedToOpenSocket|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)/.test(e.code) ? "network" : "unknown";
}
const path = (root: string, name: string) => join(root, ".state", "integrations", `${name}.json`);
const STATES: readonly string[] = ["checking", "importing", "ok", "error"];
const readReceipt = (root: string, name: string): PollStatus | undefined => {
  const s = readCursorJson(path(root, name)) as unknown as PollStatus | undefined;
  return s && STATES.includes(s.state) && Number.isFinite(Date.parse(s.at)) ? s : undefined;
};
const codeOf = (s: PollStatus): PollErrorCode | undefined =>
  s.state === "error" && (POLL_ERROR_CODES as readonly string[]).includes(s.code ?? "") ? s.code : undefined;

export function integrationStatus(root: string, name: string, enabled: boolean, configured: boolean,
  now = Date.now()): IntegrationStatus {
  if (!enabled) return { state: "off", label: "Off" };
  if (!configured) return { state: "unset", label: "Add an API key to connect" };
  const s = readReceipt(root, name);
  if (!s) return { state: "waiting", label: "Waiting for first check" };
  const dates = { checkedAt: s.checkedAt, lastArrivalAt: s.lastArrivalAt };
  if (s.state === "error") {
    const code = codeOf(s);
    return { state: "error", label: s.detail ?? "Could not sync; will retry", ...dates,
      ...(code ? { code, needsAction: needsAction(code) } : {}), ...(s.failingSince ? { failingSince: s.failingSince } : {}) };
  }
  // A killed process must not leave a permanent spinner or an old success
  // masquerading as current health. A live backfill refreshes on every page.
  if (now - Date.parse(s.at) > 180_000) return { state: "waiting", label: "Waiting for next check", ...dates };
  const label = s.state === "importing" ? "Importing history…"
    : s.state === "checking" ? "Checking…" : s.detail ?? "Up to date";
  return { state: s.state, label, ...dates };
}

/** What telemetry may say about a poller: its state, the error's code and how
 * long it has been failing. Never a message, an account or a time of day. */
export interface PollHealth { state: PollStatus["state"]; code?: PollErrorCode; failures: number; failingHours: number }
export function pollHealth(root: string, name: string, now = Date.now()): PollHealth | undefined {
  const s = readReceipt(root, name);
  if (!s) return undefined;
  const since = s.failingSince ? Date.parse(s.failingSince) : NaN, code = codeOf(s);
  return { state: s.state, ...(code ? { code } : {}), failures: Number.isSafeInteger(s.failures) ? s.failures! : 0,
    failingHours: Number.isFinite(since) ? Math.max(0, now - since) / 3_600_000 : 0 };
}

export async function withPollStatus(root: string, name: string,
  poll: (progress: (state: "checking" | "importing") => void) => Promise<{ arrivals: number; detail?: string }>): Promise<void> {
  const previous = readCursorJson(path(root, name));
  let receipt: PollStatus = {
    state: "checking", at: new Date().toISOString(),
    ...(typeof previous?.checkedAt === "string" ? { checkedAt: previous.checkedAt } : {}),
    ...(typeof previous?.lastArrivalAt === "string" ? { lastArrivalAt: previous.lastArrivalAt } : {}),
    // a poll killed mid-run neither ends nor restarts a streak of failures
    ...(Number.isSafeInteger(previous?.failures) ? { failures: previous!.failures as number } : {}),
    ...(typeof previous?.failingSince === "string" ? { failingSince: previous.failingSince } : {}),
  };
  const save = () => writeAtomic(path(root, name), JSON.stringify(receipt) + "\n");
  const progress = (state: "checking" | "importing") => {
    receipt = { ...receipt, state, at: new Date().toISOString() }; save();
  };
  progress("checking");
  try {
    const result = await poll(progress);
    const at = new Date().toISOString();
    const lastArrivalAt = result.arrivals ? at : receipt.lastArrivalAt;
    receipt = { state: "ok", at, checkedAt: at, ...(lastArrivalAt ? { lastArrivalAt } : {}),
      ...(result.detail ? { detail: result.detail } : {}) };
    save();
  } catch (error) {
    const at = new Date().toISOString();
    receipt = { ...receipt, state: "error", at, code: pollErrorCode(error),
      detail: error instanceof PollError ? error.message : "Could not sync; will retry on the next check",
      failures: (receipt.failures ?? 0) + 1, failingSince: receipt.failingSince ?? at };
    save();
    throw error;
  }
}
