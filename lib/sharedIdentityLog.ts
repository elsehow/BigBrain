/** sharedIdentityLog.ts — a shared vault's identity assertions
 * (docs/plans/2026-10-11-field-of-assertions.md, step 7): that two of its
 * landings are one work (or are not), or that an entity is one of them.
 * Only identity that cites sources reaches a server: an alias cites nothing,
 * and never enters a lens or a server. Kept apart from the server's prose
 * log, whose readers index prose alone; one event type, its validator, and
 * its create function's caller are lib/sharedVault.ts. */
import { validateRecordedAssertion, type IdentityAssertion } from "./assertionLog";
import { eventLog } from "./eventLog";

export const SHARED_IDENTITY_DIR = "log/identities";

export function validateSharedIdentity(event: IdentityAssertion): void {
  if (event.kind !== "identity") throw new Error("shared-identity: not an identity assertion");
  validateRecordedAssertion(event);
  if (!event.sources.length) throw new Error("shared-identity: a server holds only identity that cites its sources");
}

const log = eventLog<IdentityAssertion>({
  name: "shared-identity",
  dir: SHARED_IDENTITY_DIR,
  when: (event) => event.created_at,
  validate: validateSharedIdentity,
});

export const appendSharedIdentity = log.append;
export const listSharedIdentityFiles = log.listFiles;
export const sharedIdentityRel = log.rel;
