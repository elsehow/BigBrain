/**
 * Which build is the install (#329).
 *
 * Every `tauri build` used to carry the release's identity. On a development
 * machine that left dozens of launchable "BigBrain" bundles registered under
 * one bundle id, and whichever one macOS picked took the real vault and the
 * `bigbrain` command with it: on 2026-10-21 a click on BigBrain opened a
 * two-week-old bundle from a stale checkout, which could not read the vault's
 * newer events and hung at "Waiting for the engine…".
 *
 * So the base config is the dev build, and only the release command adds
 * tauri.release.conf.json. These hold that split in place: the Rust shell, the
 * engine's log reader and the runbooks all name the same release.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellLogPath } from "../lib/diagnostics";
import { ENGINE_ROOT } from "../lib/engine";

const TAURI = join(ENGINE_ROOT, "desktop", "src-tauri");
interface Conf {
  productName?: string;
  identifier?: string;
  bundle?: { createUpdaterArtifacts?: boolean };
  plugins?: { "deep-link"?: { desktop?: { schemes?: string[] } }; updater?: { pubkey?: string; endpoints?: string[] } };
}
const conf = (name: string): Conf => JSON.parse(readFileSync(join(TAURI, name), "utf8")) as Conf;
const base = conf("tauri.conf.json");
const release = conf("tauri.release.conf.json");

describe("the dev build and the release", () => {
  test("a plain build is the dev build: its own name and identifier, no link scheme, no updater artifacts", () => {
    expect(base.identifier).toBe("cool.bigbrain.desktop.dev");
    expect(base.productName).toBe("BigBrain Dev");
    expect(base.plugins?.["deep-link"]).toBeUndefined();
    expect(base.bundle?.createUpdaterArtifacts).toBe(false);
    // The updater plugin will not start without its config, so the pubkey
    // and feed stay in the base; the shell keeps a dev build off them.
    expect(base.plugins?.updater?.pubkey).toBeTruthy();
  });

  test("the release overlay restores the release's name, identifier, link scheme and updater artifacts", () => {
    expect(release).toEqual({
      $schema: "../node_modules/@tauri-apps/cli/config.schema.json",
      productName: "BigBrain",
      identifier: "cool.bigbrain.desktop",
      bundle: { createUpdaterArtifacts: true },
      plugins: { "deep-link": { desktop: { schemes: ["bigbrain"] } } },
    } as Conf);
  });

  test("the shell's RELEASE_ID is the overlay's identifier", () => {
    const rs = readFileSync(join(TAURI, "src", "lib.rs"), "utf8");
    expect(/const RELEASE_ID: &str = "([^"]+)";/.exec(rs)?.[1]).toBe(release.identifier);
  });

  test("the engine's default shell log is the release's", () => {
    expect(shellLogPath("darwin", "/Users/z")).toBe(`/Users/z/Library/Logs/${release.identifier}/${release.productName}.log`);
  });

  test("every release command in the runbooks builds with the overlay", () => {
    for (const doc of ["site/README.md", "desktop/README.md"]) {
      const lines = readFileSync(join(ENGINE_ROOT, doc), "utf8").split("\n").filter((l) => l.includes("TAURI_SIGNING_PRIVATE_KEY=") && l.includes("tauri build"));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toContain("--config src-tauri/tauri.release.conf.json");
    }
  });
});
