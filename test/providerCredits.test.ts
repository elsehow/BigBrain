import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDITS_PROBE_MS, OutOfCredits, clearCredits, creditsPaused, creditsState, withCredits } from "../lib/providerCredits";

const vault = () => mkdtempSync(join(tmpdir(), "credits-"));

test("out of credits is marked per provider with what it paused, and a success clears it", async () => {
  const root = vault();
  try {
    await expect(withCredits(root, "anthropic", "tend", async () => { throw new Error("400: Your credit balance is too low to access the API."); })).rejects.toBeInstanceOf(OutOfCredits);
    await expect(withCredits(root, "anthropic", "quick", async () => { throw new Error("Claude AI usage limit reached"); })).rejects.toBeInstanceOf(OutOfCredits);
    expect(creditsState(root)["anthropic"]).toMatchObject({ roles: ["tend", "quick"] });
    expect(creditsPaused(root, "anthropic")).toBe(true);
    expect(creditsPaused(root, "typesafe")).toBe(false);

    // any other failure is just a failure: not marked, not converted
    await expect(withCredits(root, "typesafe", "firewall", async () => { throw new Error("socket hang up"); })).rejects.toThrow("socket hang up");
    expect(creditsState(root)["typesafe"]).toBeUndefined();

    expect(await withCredits(root, "anthropic", "quick", async () => 7)).toBe(7);
    expect(creditsState(root)).toEqual({});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a pause lasts until the next probe, and Retry ends it at once", async () => {
  const root = vault();
  try {
    await withCredits(root, "openai-codex", "tend", async () => { throw new OutOfCredits("openai-codex", "You've hit your usage limit."); }).catch(() => {});
    const at = Date.parse(creditsState(root)["openai-codex"]!.at);
    expect(creditsPaused(root, "openai-codex", at + CREDITS_PROBE_MS - 1)).toBe(true);
    expect(creditsPaused(root, "openai-codex", at + CREDITS_PROBE_MS)).toBe(false); // time for one probe
    clearCredits(root);
    expect(creditsPaused(root, "openai-codex")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
