/** Vault API keys override only this runtime; never copy them into Pi's global store.
 * The engine never loads the vault's .env into its environment (lib/env.ts
 * NO_ENV_FILE), so every provider key Pi would look for there comes in here. */
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { readEnvValues } from "../envFile";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
export async function configureVaultModelAuth(runtime: ModelRuntime, root?: string): Promise<void> {
  const env = root ? readEnvValues(root) : {};
  for (const provider of runtime.getRegisteredProviderIds()) {
    // Pi's names for the provider's API key, read from the vault alone: a key
    // exported in the person's shell is Pi's own business, and an auth token is not a key.
    const name = findEnvKeys(provider, env)?.find(n => n !== "ANTHROPIC_AUTH_TOKEN" && env[n]);
    if (name) await runtime.setRuntimeApiKey(provider, env[name]!);
    else if (runtime.getProviderAuthStatus(provider).source === "runtime") await runtime.removeRuntimeApiKey(provider);
  }
}
