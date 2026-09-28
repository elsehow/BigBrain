/** A poll's health is independent of whether it found anything. These
 * receipts are disposable; credentials and remote response bodies never ride
 * them. Settings reads them without opening a poller's private cursor. */
import { join } from "node:path";
import { writeAtomic } from "./fsx";
import { readCursorJson } from "./integrationCursor";

export interface PollStatus {
  state: "checking" | "importing" | "ok" | "error";
  at: string;
  checkedAt?: string;
  lastArrivalAt?: string;
  detail?: string;
}
export interface IntegrationStatus {
  state: "off" | "unset" | "waiting" | PollStatus["state"];
  label: string;
  checkedAt?: string;
  lastArrivalAt?: string;
}
export class PollError extends Error {}
const path = (root: string, name: string) => join(root, ".state", "integrations", `${name}.json`);

export function integrationStatus(root: string, name: string, enabled: boolean, configured: boolean,
  now = Date.now()): IntegrationStatus {
  if (!enabled) return { state: "off", label: "Off" };
  if (!configured) return { state: "unset", label: "Add an API key to connect" };
  const s = readCursorJson(path(root, name)) as unknown as PollStatus | undefined;
  if (!s || !["checking", "importing", "ok", "error"].includes(s.state) || !Number.isFinite(Date.parse(s.at))) return { state: "waiting", label: "Waiting for first check" };
  const dates = { checkedAt: s.checkedAt, lastArrivalAt: s.lastArrivalAt };
  if (s.state === "error") return { state: "error", label: s.detail ?? "Could not sync; will retry", ...dates };
  // A killed process must not leave a permanent spinner or an old success
  // masquerading as current health. A live backfill refreshes on every page.
  if (now - Date.parse(s.at) > 180_000) return { state: "waiting", label: "Waiting for next check", ...dates };
  const label = s.state === "importing" ? "Importing history…"
    : s.state === "checking" ? "Checking…" : s.detail ?? "Up to date";
  return { state: s.state, label, ...dates };
}

export async function withPollStatus(root: string, name: string,
  poll: (progress: (state: "checking" | "importing") => void) => Promise<{ arrivals: number; detail?: string }>): Promise<void> {
  const previous = readCursorJson(path(root, name));
  let receipt: PollStatus = {
    state: "checking", at: new Date().toISOString(),
    ...(typeof previous?.checkedAt === "string" ? { checkedAt: previous.checkedAt } : {}),
    ...(typeof previous?.lastArrivalAt === "string" ? { lastArrivalAt: previous.lastArrivalAt } : {}),
  };
  const save = () => writeAtomic(path(root, name), JSON.stringify(receipt) + "\n");
  const progress = (state: "checking" | "importing") => {
    receipt = { ...receipt, state, at: new Date().toISOString() }; save();
  };
  progress("checking");
  try {
    const result = await poll(progress);
    const at = new Date().toISOString();
    receipt = { ...receipt, state: "ok", at, checkedAt: at,
      ...(result.arrivals ? { lastArrivalAt: at } : {}),
      ...(result.detail ? { detail: result.detail } : {}) };
    save();
  } catch (error) {
    receipt = { ...receipt, state: "error", at: new Date().toISOString(),
      detail: error instanceof PollError ? error.message : "Could not sync; will retry on the next check" };
    save();
    throw error;
  }
}
