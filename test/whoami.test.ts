// `bigbrain whoami` — the checkout's door to who the vault is about (#572).
// Run as the CLI is run: a subprocess on BIGBRAIN_VAULT.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { latestUserIdentity } from "../lib/userIdentity";
import { nativeVault } from "./support/vault";

const whoami = (root: string, ...args: string[]) =>
  spawnSync("bun", [join(ENGINE_ROOT, "bin", "whoami.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, BIGBRAIN_VAULT: root },
  });

describe("bigbrain whoami", () => {
  test("nothing declared: exit 1 and the door named", () => {
    const bare = whoami(nativeVault());
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("--declare");
  });

  test("--declare with --alias says the whole alias list, the email first; the read shows it", () => {
    const root = nativeVault();
    const d = whoami(root, "--declare", "Ada Lovelace", "--alias", "A.L.", "--email", "ada@example.com");
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("Ada Lovelace is the owner of this vault");
    expect(d.stdout).toContain("also known as A.L.");
    expect(latestUserIdentity(root)).toMatchObject({
      name: "Ada Lovelace",
      account_id: "ada@example.com",
      aliases: ["ada@example.com", "A.L."],
    });
    const r = whoami(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Ada Lovelace (");
    expect(r.stdout).toContain("also known as ada@example.com, A.L.");
  });
});
