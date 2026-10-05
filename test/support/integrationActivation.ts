/** Test-only receipt for mocked providers. Never call against a real vault. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../../lib/fsx";
import { sha256hex } from "../../lib/hash";
import { parse, stringify } from "yaml";
import { integrationFingerprint, saveIntegrationActivation } from "../../lib/integrationAccess";
export function fakeIntegrationActivation(root: string, name = "email") {
  const path = join(root, "vault.yaml"), cfg = parse(readFileSync(path, "utf8")) ?? {};
  cfg.integrations ??= {}; cfg.integrations[name] ??= {};
  if(name === "email" && !cfg.integrations.email.inboxes?.length)cfg.integrations.email.inboxes=[{address:"fixture@example.com",host:"imap.example.com"}];
  cfg.integrations[name].enabled = true;
  writeFileSync(path, stringify(cfg));
  if(name==='granola')writeAtomic(join(root,'.spool/source-mcp/granola',sha256hex(name)+'.json'),JSON.stringify({generation:'fixture',connected:true,redirect:'http://127.0.0.1/callback',tokens:{access_token:'synthetic',token_type:'Bearer'},identity:{workspace:'fixture'}}),0o600);
  saveIntegrationActivation(root, name, [], integrationFingerprint(root, name));
}
