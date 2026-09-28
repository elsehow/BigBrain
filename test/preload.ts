/**
 * preload.ts — test isolation (bunfig.toml `[test].preload`, #635).
 *
 * bun runs every test file in ONE process, and an entry point resolves
 * VAULT_ROOT at IMPORT time (lib/vaultRoot.ts) — so whichever test file
 * loaded first used to pick the vault for everyone else, and the old
 * per-file `??=` dodge let a developer's real BIGBRAIN_VAULT feed
 * import-time state (web/server.ts included). Set unconditionally, before
 * any test file loads: the suite never sees a real vault. Tests that care
 * which vault they run against pass their own root explicitly anyway.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bb-test-vault-"));
writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
process.env["BIGBRAIN_VAULT"] = root;
