import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_SHIM_MARKER, bigbrainCommandPath, engineBehindCommand, isAppShim } from "../lib/bigbrainCommand";

const scratch = () => mkdtempSync(join(tmpdir(), "bb-cmd-"));

describe("the bigbrain command — which engine it runs", () => {
  test("lives at ~/.local/bin/bigbrain", () => {
    expect(bigbrainCommandPath("/home/x")).toBe("/home/x/.local/bin/bigbrain");
  });

  test("an install's symlink names its checkout", () => {
    const dir = scratch();
    mkdirSync(join(dir, "checkout", "bin"), { recursive: true });
    writeFileSync(join(dir, "checkout", "bin", "cli.ts"), "");
    const link = join(dir, "bigbrain");
    symlinkSync(join(dir, "checkout", "bin", "cli.ts"), link);
    expect(engineBehindCommand(link)).toBe(join(dir, "checkout"));
    expect(isAppShim(link)).toBe(false);
  });

  test("the app's shim names its engine on the `# engine:` line", () => {
    const dir = scratch();
    const link = join(dir, "bigbrain");
    writeFileSync(
      link,
      `#!/bin/sh\n${APP_SHIM_MARKER} — the \`bigbrain\` command.\n# engine: /Applications/BigBrain.app/Contents/Resources/resources/engine\nexec '/x/bun' '/x/engine/bin/cli.ts' "$@"\n`
    );
    expect(isAppShim(link)).toBe(true);
    expect(engineBehindCommand(link)).toBe("/Applications/BigBrain.app/Contents/Resources/resources/engine");
  });

  test("nothing, a stranger's script, or a symlink to something else → null", () => {
    const dir = scratch();
    expect(engineBehindCommand(join(dir, "missing"))).toBeNull();
    const mine = join(dir, "mine");
    writeFileSync(mine, "#!/bin/sh\necho mine\n");
    expect(engineBehindCommand(mine)).toBeNull();
    expect(isAppShim(mine)).toBe(false);
    const elsewhere = join(dir, "elsewhere");
    symlinkSync("/usr/bin/true", elsewhere);
    expect(engineBehindCommand(elsewhere)).toBeNull();
  });
});
