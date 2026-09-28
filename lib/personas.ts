/**
 * personas.ts — two known-name lists (#265 addendum), split out from
 * manifest.ts so this file can have NO imports and no top-level side
 * effects. It was load-bearing while manifest.ts resolved the vault at
 * import (lib/noteMeta.ts had to reach the lists without paying for a
 * vault); that constant lives in lib/vaultRoot.ts now, so the split is
 * ordinary tidiness. manifest.ts re-exports both so bin/ and web/, which
 * already import it for everything else, find them there.
 */

/** An integration REMOVED from the engine: its directory is gone, so a
 * vault.yaml that still names it (upgraded hosts keep old entries for a
 * while) must not offer a toggle for something that cannot run, and a
 * scheduler must shed any job still loaded for it. Email went in two steps
 * (the inbound poller 2026-08-10, then the outbound dispatcher/outbox tree
 * the same day); vault-clean's code left 2026-08-05 but its vault.yaml
 * block kept seeding new vaults until 2026-08-12. Email CAME BACK on
 * 2026-09-04 as the IMAP poller under integrations/email/ (#744) — the
 * outbound dispatcher stays retired. */
export const RETIRED_INTEGRATIONS = new Set(["outbox", "vault-clean", "agent-chat"]);

/** Values a note's `from`/filed-by can carry that name the EDITOR's own
 * machinery, never a person, integration, or channel — the queue runner
 * personas (`editor`, and the pre-2026-08-02 `deep`/`triage` history keeps
 * banding truthfully), the maintenance passes (`survey`, `runner`,
 * `librarian`), and the one-shot setup/config personas (`init`, `config`,
 * `intake`, `engine`, `vault-clean`). Union of the two lists that drifted
 * apart (lib/noteMeta.ts's provenance banding, web/ui's filed-by column) —
 * strictly wider than either: every member here really is internal, so
 * recognizing one the other side used to miss can only fix a mislabel,
 * never cause one. */
export const INTERNAL_PERSONAS = new Set([
  "editor",
  "deep",
  "triage",
  "runner",
  "survey",
  "librarian",
  "init",
  "config",
  "intake",
  "engine",
  "vault-clean",
]);
