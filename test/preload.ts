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

// The machine's Jev key turns the intake firewall on (lib/firewall.ts), and
// it lives beside the shared-connections store: a developer's real key must
// never put every test's arrival to the real Jev. Tests that want a key
// point this at their own store.
process.env["BIGBRAIN_SHARED_CONNECTIONS"] = join(mkdtempSync(join(tmpdir(), "bb-test-connections-")), "shared-connections.json");
delete process.env["TYPESAFE_API_KEY"];

// The read log (lib/readLog.ts) lives under ~/.config/bigbrain: a test's live
// calls must never land in the developer's.
process.env["BIGBRAIN_READ_LOG"] = mkdtempSync(join(tmpdir(), "bb-test-reads-"));

// Catalog refresh is automatic in production; tests must explicitly inject a
// fabricated transport before opting into model metadata network behavior.
process.env.PI_OFFLINE = "1";
