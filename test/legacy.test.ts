/**
 * Retired installs (lib/legacy.ts): the hosted-era plugin dir is moved
 * aside, never deleted.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireHostPluginDir } from "../lib/legacy";

const home = (): string => mkdtempSync(join(tmpdir(), "bb-legacy-"));

describe("the hosted-era plugin dir (#693)", () => {
  test("retireHostPluginDir moves ~/.bigbrain/plugin aside, keeps every file, leaves state/ alone", () => {
    const h = home();
    expect(retireHostPluginDir(h).status).toBe("none");
    mkdirSync(join(h, ".bigbrain", "plugin", "scripts"), { recursive: true });
    writeFileSync(join(h, ".bigbrain", "plugin", "scripts", "search.sh"), "old\n");
    mkdirSync(join(h, ".bigbrain", "state", "agent-chat"), { recursive: true });
    writeFileSync(join(h, ".bigbrain", "state", "agent-chat", "cursor"), "42\n");
    const day = new Date("2026-09-02T10:00:00Z");
    const r = retireHostPluginDir(h, day);
    expect(r.status).toBe("moved");
    expect(r.to).toBe(join(h, ".bigbrain", "plugin-retired-2026-09-02"));
    expect(existsSync(join(h, ".bigbrain", "plugin"))).toBe(false);
    expect(readFileSync(join(r.to, "scripts", "search.sh"), "utf8")).toBe("old\n");
    expect(readFileSync(join(h, ".bigbrain", "state", "agent-chat", "cursor"), "utf8")).toBe("42\n");
    expect(retireHostPluginDir(h, day).status).toBe("none");
    // a second copy on the same day does not clobber the first
    mkdirSync(join(h, ".bigbrain", "plugin"));
    const again = retireHostPluginDir(h, day);
    expect(again.status).toBe("moved");
    expect(again.to).not.toBe(r.to);
    expect(existsSync(r.to)).toBe(true);
  });
});
