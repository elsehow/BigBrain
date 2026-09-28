import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitAs, commitPathsOnly } from "../lib/git";
import { gitVault } from "./support/vault";

// Item D (§4.2d) — the host-side git-hook neutralization half. A poisoned clip
// that writes .git/hooks/* in the rw vault would otherwise get code-exec as the
// process owner on the next MACHINE commit. commitAs/commitPathsOnly run with
// `-c core.hooksPath=/dev/null` — the rule the retired hosted runner's
// container half enforced with an empty read-only tmpfs over .git/hooks.

function repo(): string {
  const root = gitVault({
    prefix: "bb-git-",
    files: { "seed.md": "seed\n" },
    identity: { name: "seed", email: "seed@test" },
  });
  mkdirSync(join(root, "entities"), { recursive: true });
  return root;
}

/** Arm a pre-commit hook that writes a sentinel AND exits non-zero. With hooks
 * LIVE it would both drop the sentinel and BLOCK the commit; neutralized, the
 * commit succeeds and the sentinel never appears — the exact poisoned-hook
 * vector, proven dead. Returns the sentinel path. */
function armMaliciousHook(root: string): string {
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  const sentinel = join(root, "PWNED");
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ntouch "${sentinel}"\nexit 1\n`);
  chmodSync(hook, 0o755);
  return sentinel;
}

describe("machine commits neutralize git hooks (§4.2d host-side half)", () => {
  test("commitAs commits with a poisoned pre-commit hook armed — the hook never fires", () => {
    const root = repo();
    const sentinel = armMaliciousHook(root);
    writeFileSync(join(root, "entities", "note.md"), "x\n");
    // a live hook would exit 1 and abort the commit; neutralized, it succeeds
    expect(commitAs(root, "editor", "machine commit", ["entities"])).toBe(true);
    expect(existsSync(sentinel)).toBe(false); // the hook body did not run
  });

  test("commitPathsOnly is likewise hook-free", () => {
    const root = repo();
    const sentinel = armMaliciousHook(root);
    writeFileSync(join(root, "entities", "note.md"), "y\n");
    expect(commitPathsOnly(root, "editor", "partial machine commit", ["entities"])).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });
});
