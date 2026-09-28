// `bigbrain whoami` — the checkout's door to who the vault is about (#572),
// and since #683 the one that folds a hosted-era `human_user` dossier into
// the declaration. Run as the CLI is run: a subprocess on BIGBRAIN_VAULT.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { latestUserIdentity, userIdentityDeclarations } from "../lib/userIdentity";
import { declareOwner } from "./support/identity";
import { nativeVault } from "./support/vault";

const whoami = (root: string, ...args: string[]) =>
  spawnSync("bun", [join(ENGINE_ROOT, "bin", "whoami.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, BIGBRAIN_VAULT: root },
  });

const DOSSIER = "---\ntype: entity\nentity_type: person\ntitle: Ada Lovelace\nhuman_user: true\naliases:\n  - Ada\n  - Countess\n  - ada@example.com\n---\n\nThe editor's answer.\n";
function withDossier(root: string): string {
  mkdirSync(join(root, "entities"), { recursive: true });
  writeFileSync(join(root, "entities", "ada-lovelace.md"), DOSSIER);
  return root;
}

describe("bigbrain whoami", () => {
  test("nothing declared: exit 1 and the door named; a dossier is mentioned as coming along", () => {
    const bare = whoami(nativeVault());
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("--declare");
    expect(bare.stderr).not.toContain("comes along");
    const r = whoami(withDossier(nativeVault()));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("entities/ada-lovelace.md comes along");
  });

  test("--declare with --alias carries the dossier's labels along, the name itself excluded; the read shows nothing left to adopt", () => {
    const root = withDossier(nativeVault());
    const d = whoami(root, "--declare", "Ada Lovelace", "--alias", "A.L.", "--email", "ada@example.com");
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("Ada Lovelace is the owner of this vault");
    expect(d.stdout).toContain("also known as A.L., Ada, Countess");
    expect(latestUserIdentity(root)).toMatchObject({
      name: "Ada Lovelace",
      account_id: "ada@example.com",
      aliases: ["ada@example.com", "A.L.", "Ada", "Countess"],
    });
    const r = whoami(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Ada Lovelace (");
    expect(r.stdout).toContain("also known as ada@example.com, A.L., Ada, Countess");
    expect(r.stdout).not.toContain("still holds");
  });

  test("a hosted-era declaration beside the dossier: the read says what the dossier still holds, --adopt-dossier folds it in once", () => {
    const root = withDossier(nativeVault());
    const first = declareOwner(root, {
      account: "acct_ada", verified_email: "ada@example.com", name: "Ada Lovelace",
      aliases: ["ada@example.com"], now: new Date("2026-08-23T00:00:00Z"),
    });
    const before = whoami(root);
    expect(before.status).toBe(0);
    expect(before.stdout).toContain("entities/ada-lovelace.md still holds 2 label(s) the declaration lacks: Ada, Countess");
    expect(before.stdout).toContain("--adopt-dossier");

    const adopt = whoami(root, "--adopt-dossier");
    expect(adopt.status).toBe(0);
    expect(adopt.stdout).toContain("adopted entities/ada-lovelace.md — Ada Lovelace is also known as Ada, Countess");
    expect(adopt.stdout).toContain("as ada@example.com"); // acct_ada is a tenant id, not an email
    expect(userIdentityDeclarations(root)).toHaveLength(2);
    expect(latestUserIdentity(root)).toMatchObject({
      name: "Ada Lovelace", entity_id: first.entity_id, account_id: "ada@example.com",
      aliases: ["ada@example.com", "Ada", "Countess"],
    });
    expect(readFileSync(join(root, "entities", "ada-lovelace.md"), "utf8")).toBe(DOSSIER);

    const again = whoami(root, "--adopt-dossier");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to adopt");
    expect(userIdentityDeclarations(root)).toHaveLength(2);
    expect(whoami(root).stdout).not.toContain("still holds");
  });

  test("--adopt-dossier with no dossier is nothing to do; with a dossier and no declaration it points at --declare; with --declare it is refused", () => {
    const none = whoami(nativeVault(), "--adopt-dossier");
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("nothing to adopt");
    const undeclared = whoami(withDossier(nativeVault()), "--adopt-dossier");
    expect(undeclared.status).toBe(2);
    expect(undeclared.stderr).toContain("--declare");
    const both = whoami(nativeVault(), "--adopt-dossier", "--declare", "Ada");
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("takes no --declare");
  });
});
