// lib/run/piModelRuntime.ts — vault keys reach Pi's runtime without the process env.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configureVaultModelAuth } from "../lib/run/piModelRuntime";

/** The slice of ModelRuntime configureVaultModelAuth uses, recording what it is told. */
function fakeRuntime(providers: string[], runtimeKeys: Record<string, string> = {}) {
  const keys = { ...runtimeKeys };
  const runtime = {
    getRegisteredProviderIds: () => providers,
    getProviderAuthStatus: (p: string) => (p in keys ? { configured: true, source: "runtime" } : { configured: false }),
    setRuntimeApiKey: async (p: string, k: string) => { keys[p] = k; },
    removeRuntimeApiKey: async (p: string) => { delete keys[p]; },
  } as unknown as ModelRuntime;
  return { runtime, keys };
}

test("every provider key in the vault .env reaches the runtime, not only OpenAI's", async () => {
  const vault = mkdtempSync(join(tmpdir(), "bigbrain-pi-auth-"));
  writeFileSync(join(vault, ".env"), "OPENAI_API_KEY=sk-o\nANTHROPIC_API_KEY=sk-a\nGEMINI_API_KEY=g-1\nBIGBRAIN_PILOT_ENABLED=1\n");
  const { runtime, keys } = fakeRuntime(["openai", "anthropic", "google", "groq"]);
  await configureVaultModelAuth(runtime, vault);
  expect(keys).toEqual({ openai: "sk-o", anthropic: "sk-a", google: "g-1" });
  rmSync(vault, { recursive: true, force: true });
});

test("a key exported only in the process env is left to Pi, and a stale vault key is withdrawn", async () => {
  const vault = mkdtempSync(join(tmpdir(), "bigbrain-pi-auth-"));
  writeFileSync(join(vault, ".env"), "OPENAI_API_KEY=sk-o\n");
  const before = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "from-shell";
  try {
    const { runtime, keys } = fakeRuntime(["openai", "anthropic", "groq"], { anthropic: "previous-vault" });
    await configureVaultModelAuth(runtime, vault);
    expect(keys).toEqual({ openai: "sk-o" });
  } finally {
    if (before === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = before;
    rmSync(vault, { recursive: true, force: true });
  }
});
