/** The door: the ONE way an arrival is persisted. Landing it in the record
 * (`receive`, lib/intake.ts) and staging it for the gardener (`stage`,
 * lib/stageStorage.ts) both sit behind the firewall (lib/firewall.ts), and
 * only this module may call either — test/door.test.ts holds every other
 * module to that. Staging is persistence too: the gardener reads a staged
 * body before deciding, so a reset email screened only at landing would
 * already have been read by an agent.
 *
 * Withheld means nothing persists. A drop is refused with a reason; a
 * poller's item is dropped with one metadata line and the poller moves on.
 * An unreachable firewall throws: a drop is refused, a poller leaves the
 * item at its source and retries. */

import { FirewallUnavailable, recordWithheld, screen, type Verdict } from "./firewall";
import { IntakeError, receive, type IntakeReceipt, type ReceiveItemOpts } from "./intake";
import { stage, type StagedItem } from "./stageStorage";

export { FirewallUnavailable };

/** A drop door's HTTP status for a failed landing: 413 too large, 422
 * withheld, 503 firewall unreachable (the sender should retry), else 400. */
export function dropErrorStatus(e: unknown): number {
  if (e instanceof FirewallUnavailable) return 503;
  if (e instanceof IntakeError) return e.code === "too-large" ? 413 : e.code === "withheld" ? 422 : 400;
  return 400;
}

declare const screenedBrand: unique symbol;
/** Proof that an item went through the firewall and passed — the only way
 * to the synchronous landings below, for callers that must screen before
 * taking a lock (a network call cannot happen under one). */
export type Screened = { readonly [screenedBrand]: true };

/** Screen, recording a withheld item. `null` means withheld. */
export async function clear(
  root: string,
  source: string,
  content: string,
  attachments: ReceiveItemOpts["attachments"] = [],
): Promise<Screened | null> {
  const verdict: Verdict = await screen(root, content, attachments);
  if (verdict.pass) return {} as Screened;
  recordWithheld(root, source, content, verdict);
  return null;
}

/** Land an arrival in the record. A withheld item throws IntakeError
 * "withheld" — a drop must tell its sender nothing landed. */
export async function land(opts: ReceiveItemOpts & { source?: string }): Promise<IntakeReceipt> {
  const { source = "drop", ...rest } = opts;
  if (!(await clear(rest.root, source, rest.content, rest.attachments)))
    throw new IntakeError("withheld", "withheld by the firewall: this looks like it carries a credential — nothing landed");
  return receive(rest);
}

/** Stage a poller's find for the gardener. Withheld → false, as for an item
 * already staged: there is nothing new for the gardener. */
export async function hold(root: string, item: StagedItem): Promise<boolean> {
  const cleared = await clear(root, item.source, item.content, item.attachments);
  return cleared ? stage(root, item) : false;
}

/** `hold` for a caller that screened first and stages under a lock. */
export function holdCleared(_cleared: Screened, root: string, item: StagedItem): boolean {
  return stage(root, item);
}

/** Admission of an item that was screened when it was staged. Only the
 * admission paths call this (test/door.test.ts). */
export function admit(opts: ReceiveItemOpts): IntakeReceipt {
  return receive(opts);
}
