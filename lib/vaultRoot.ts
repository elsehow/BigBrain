/**
 * vaultRoot.ts — the ONE import-time vault resolution in the engine.
 *
 * An entry point that cannot run without a vault imports VAULT_ROOT from
 * here and gets the discovered root as a constant, so every
 * `join(VAULT_ROOT, …)` below it is absolute with no plumbing. Importing
 * this module THROWS when no vault can be found — that is the point, and it
 * is why it is a file of its own.
 *
 * It used to live in lib/manifest.ts, next to the config parser. That made
 * the config parser un-importable without a vault, so half the library
 * routed around it: six modules carried a comment explaining that they must
 * never import manifest.ts, and lib/agentChat.ts re-implemented the
 * vault.yaml parse rather than reach for the one that already existed. The
 * config reader is side-effect-free now (#524 follow-up); the detonation
 * lives here, where a module has to ask for it by name.
 *
 * `bin/*` is the right importer. A `lib/` module should take `root` as an
 * argument instead — it may be running against a scratch vault, a test
 * fixture, or (lib/api.ts) no vault at all.
 */

import { requireVaultRoot } from "./engine";

/** The vault root — DISCOVERED, not assumed: the engine and the vault are
 * separate directories (see lib/engine.ts for the mechanisms). Resolved at
 * import; throws, naming every mechanism, when there is no vault. */
export const VAULT_ROOT = requireVaultRoot();
