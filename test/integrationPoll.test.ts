import { fakeIntegrationActivation } from "./support/integrationActivation";
/**
 * lib/integrationPoll.ts — the shared skeleton under granola's and
 * agent-chat's pollers (#265): the enabled gate, the state file path, and
 * the corrupt-cursor tolerance agent-chat had and granola's inline
 * `JSON.parse(readFileSync(...))` didn't (an unreadable cursor used to take
 * granola's whole poll down; both integrations now rebuild instead of
 * crashing).
 */
import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/integrationPoll.ts imports lib/vaultRoot.ts, which resolves VAULT_ROOT
// at IMPORT time — test/preload.ts points it at a scratch vault before any
// test file loads (#635).
const { integrationStateFile, readCursorJson, requireIntegrationEnabled } = await import(
  "../lib/integrationPoll"
);
const { VAULT_ROOT } = await import("../lib/vaultRoot");

describe("integrationStateFile", () => {
  test("one file per integration name, under the vault's .state/", () => {
    expect(integrationStateFile("granola", VAULT_ROOT)).toBe(join(VAULT_ROOT, ".state", "granola.json"));
    expect(integrationStateFile("agent-chat", VAULT_ROOT)).toBe(
      join(VAULT_ROOT, ".state", "agent-chat.json")
    );
  });
});

describe("readCursorJson — corrupt-tolerant, agent-chat's original guarantee shared with granola", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "bb-cursor-"));

  test("never written yet → undefined, not a throw", () => {
    const dir = scratch();
    expect(readCursorJson(join(dir, "nope.json"))).toBeUndefined();
  });

  test("valid JSON object → parsed through", () => {
    const dir = scratch();
    const f = join(dir, "cursor.json");
    writeFileSync(f, JSON.stringify({ lastPolledAt: "2026-01-01T00:00:00Z", seen: ["a", "b"] }));
    expect(readCursorJson(f)).toEqual({ lastPolledAt: "2026-01-01T00:00:00Z", seen: ["a", "b"] });
  });

  test("truncated/corrupt JSON → undefined, not a throw (the exact bug granola had)", () => {
    const dir = scratch();
    const f = join(dir, "cursor.json");
    writeFileSync(f, '{"lastPolledAt": "2026-01-01T00:00:00Z", "seen": [');
    expect(() => readCursorJson(f)).not.toThrow();
    expect(readCursorJson(f)).toBeUndefined();
  });

  test("valid JSON but not an object (e.g. a bare array or number) → undefined", () => {
    const dir = scratch();
    const f = join(dir, "cursor.json");
    writeFileSync(f, "42");
    expect(readCursorJson(f)).toBeUndefined();
  });
});

describe("requireIntegrationEnabled", () => {
  afterEach(() => {
    // vault.yaml is read via loadManifest's own cache-free path each call —
    // nothing to restore beyond the exit spy, which is per-test anyway.
  });

  test("enabled integration → does not exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-integrationpoll-"));
    writeFileSync(join(dir, "vault.yaml"), "integrations:\n  granola: {}\n");
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("should not exit");
    }) as unknown as typeof process.exit);
    try {
      fakeIntegrationActivation(dir, "granola");
      expect(() => requireIntegrationEnabled("granola", dir)).not.toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("disabled integration (enabled: false) → exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-integrationpoll-"));
    writeFileSync(join(dir, "vault.yaml"), "integrations:\n  granola:\n    enabled: false\n");
    let exitedWith: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitedWith = code;
      throw new Error("__exit__"); // unwind out of requireIntegrationEnabled, like a real exit would
    }) as unknown as typeof process.exit);
    try {
      expect(() => requireIntegrationEnabled("granola", dir)).toThrow("__exit__");
      expect(exitedWith).toBe(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
