/**
 * integrationPoll.ts — the shared skeleton under the inbound pollers
 * (granola, agent-chat, #265): the enabled gate, the state file path, and
 * a corrupt-tolerant cursor read. agent-chat had the tolerance from the
 * start ("A cursor is a cache: the right answer to an unreadable one is to
 * rebuild it, not to stop capturing"); granola's own
 * `JSON.parse(readFileSync(...))` had no try/catch and took the whole poll
 * down on one bad write — the corrupt-cursor tolerance both share now.
 *
 * Everything past "here is last poll's raw JSON, or undefined" — what
 * fields a cursor has, how "new" is decided, what gets fetched or read —
 * stays each integration's own business; that is most of both files and
 * it does not converge.
 */

import { integrationActive } from "./integrationAccess";

/** Exit now (code 0) if vault.yaml disables this integration — before any
 * network call or state read. The plist/timer may still fire on its own
 * schedule regardless of vault.yaml; this is the check that keeps a
 * disabled integration inert when it does. Call first, always. `root`
 * is the vault root — a test passes a scratch vault. */
export function requireIntegrationEnabled(name: string, root: string): void {
  if (!integrationActive(root, name)) process.exit(0);
}

export { integrationStateFile, readCursorJson } from "./integrationCursor";
